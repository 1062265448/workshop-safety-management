import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma.service'
import { OutboxService } from '../outbox/outbox.module'
import { AuditService } from '../audit/audit.module'
import {
  assertPatchFields,
  checkCountermeasure,
  normalizeDate,
  normalizeIdempotencyKey,
  normalizeIssueInput,
  normalizeStringArray,
  normalizeText,
  requestHash,
} from './issue-input'

const REG_INCLUDE = { issueRegulations: { include: { regulation: true } } } as const
type IssueWithRegulations = Prisma.IssueGetPayload<{ include: typeof REG_INCLUDE }>
export type IssueContext = { actor?: string; requestId?: string | null }

function serialize<T extends { issueRegulations?: { regulation: unknown }[] }>(issue: T): Omit<T, 'issueRegulations'> & { regulations: unknown[] } {
  const { issueRegulations, ...rest } = issue
  return { ...rest, regulations: (issueRegulations ?? []).map((item) => item.regulation) }
}

const STAGE_ORDER = ['rechecking', 'institutionalizing', 'educating', 'executing', 'done'] as const
const sameArray = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((value, index) => value === b[index])

@Injectable()
export class IssuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  private context(context?: IssueContext) {
    return { actor: context?.actor || 'system', requestId: context?.requestId || null }
  }

  async findAll(filters: { status?: string; categoryId?: string; locationId?: string; q?: string; bin?: boolean }) {
    const where: Prisma.IssueWhereInput = { deletedAt: filters.bin ? { not: null } : null }
    if (filters.status) where.status = filters.status
    if (filters.categoryId) where.categoryId = filters.categoryId
    if (filters.locationId) where.locationId = filters.locationId
    if (filters.q) where.OR = [{ title: { contains: filters.q } }, { description: { contains: filters.q } }]
    const issues = await this.prisma.issue.findMany({ where, orderBy: { createdAt: 'desc' }, include: REG_INCLUDE })
    return issues.map(serialize)
  }

  async findOne(id: string) {
    const issue = await this.prisma.issue.findUnique({ where: { id }, include: REG_INCLUDE })
    if (!issue) throw new NotFoundException(`Issue ${id} not found`)
    return serialize(issue)
  }

  private async workflowIssue(id: string) {
    const issue = await this.findOne(id)
    if (issue.deletedAt) throw new ConflictException('回收站中的隐患只能恢复或彻底删除，不能执行工作流命令')
    return issue
  }

  private async conflictOrLatest(
    count: number,
    id: string,
    targetReached: (issue: Awaited<ReturnType<IssuesService['findOne']>>) => boolean,
  ) {
    if (count) return null
    const latest = await this.workflowIssue(id)
    if (targetReached(latest)) return latest
    throw new ConflictException('隐患已被其他请求修改，当前操作目标未达成，请刷新后重试')
  }

  async create(body: Record<string, unknown>, context?: IssueContext) {
    const requestKey = normalizeIdempotencyKey(body?.idempotencyKey ?? body?.requestKey)
    const data = normalizeIssueInput(body, 'create')
    checkCountermeasure(data)
    const hash = requestHash(data)
    const existing = await this.prisma.issue.findUnique({ where: { requestKey }, include: REG_INCLUDE })
    if (existing) {
      if (existing.requestHash !== hash) throw new ConflictException('相同幂等键对应了不同的创建内容')
      return serialize(existing)
    }

    let created: IssueWithRegulations
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const issue = await tx.issue.create({ data: { ...data, requestKey, requestHash: hash }, include: REG_INCLUDE })
        const ctx = this.context(context)
        await this.audit.record(tx, {
          issueId: issue.id,
          ...ctx,
          action: 'issue.create',
          to: { status: issue.status, stage: issue.stage, scope: issue.scope },
          detail: { title: issue.title, requestKey },
        })
        await this.outbox.enqueueIssueEffects(tx, issue, `issue:create:${requestKey}`)
        return issue
      })
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        const replay = await this.prisma.issue.findUnique({ where: { requestKey }, include: REG_INCLUDE })
        if (replay) {
          if (replay.requestHash !== hash) throw new ConflictException('相同幂等键对应了不同的创建内容')
          return serialize(replay)
        }
      }
      throw error
    }
    this.outbox.kick()
    return serialize(created)
  }

  async update(id: string, body: Record<string, unknown>, context?: IssueContext) {
    assertPatchFields(body)
    if ((Object.prototype.hasOwnProperty.call(body, 'fixNote') || Object.prototype.hasOwnProperty.call(body, 'photos'))) {
      const current = await this.workflowIssue(id)
      if (current.status === 'closed') {
        throw new BadRequestException('闭环后的 fixNote/photos 只能通过证据更正命令修改，并必须填写 reason')
      }
    }
    const before = await this.workflowIssue(id)
    const data = normalizeIssueInput(body, 'update')
    checkCountermeasure(data, before)
    const operationKey = `issue:update:${id}:${randomUUID()}`
    await this.prisma.$transaction(async (tx) => {
      await tx.issue.update({ where: { id }, data })
      const updated = await tx.issue.findUnique({ where: { id }, include: REG_INCLUDE })
      if (!updated) throw new NotFoundException(`Issue ${id} not found`)
      const ctx = this.context(context)
      await this.audit.record(tx, {
        issueId: id,
        ...ctx,
        action: 'issue.update',
        from: { title: before.title, scope: before.scope },
        to: { title: updated.title, scope: updated.scope },
        detail: { fields: Object.keys(data) },
      })
      await this.outbox.enqueueIssueEffects(tx, updated, operationKey)
      if (before.gridOwner !== updated.gridOwner) {
        await this.outbox.enqueue(tx, 'reminder.gridowner', `${operationKey}:reminder:old`, { name: before.gridOwner })
      }
      if (before.isGood && !updated.isGood) {
        await this.outbox.enqueue(tx, 'knowledge.good.sync', `${operationKey}:good`, { issueId: id })
      }
    })
    this.outbox.kick()
    return this.findOne(id)
  }

  async updateStatus(id: string, status?: string, context?: IssueContext) {
    if (!status || !['pending', 'fixing', 'review'].includes(status)) {
      throw new BadRequestException('status 仅支持 pending、fixing、review；闭环请使用 close 接口')
    }
    const issue = await this.workflowIssue(id)
    if (!['managed', 'reference'].includes(issue.scope)) throw new BadRequestException('隐患 scope 非法，只能为 managed 或 reference')
    if (issue.scope === 'reference' && (status === 'fixing' || status === 'review')) {
      throw new BadRequestException('其他车间的问题仅作参考，不能进入整改中或待复查状态')
    }
    if (issue.status === status) return issue
    const allowedNext: Record<string, string[]> = { pending: ['fixing'], fixing: ['review'], review: [] }
    if (!allowedNext[issue.status]?.includes(status)) {
      throw new BadRequestException('隐患状态只能按 pending → fixing → review 顺序推进，不能回退、跳级或直接闭环')
    }
    const operationKey = `issue:status:${id}:${randomUUID()}`
    const early = await this.prisma.$transaction(async (tx) => {
      const result = await tx.issue.updateMany({ where: { id, status: issue.status, deletedAt: null }, data: { status } })
      if (!result.count) return false
      await this.audit.record(tx, {
        issueId: id,
        ...this.context(context),
        action: 'issue.status',
        from: issue.status,
        to: status,
      })
      await this.outbox.enqueue(tx, 'knowledge.issue.sync', `${operationKey}:knowledge`, { issueIds: [id] })
      return true
    })
    const conflict = early ? null : await this.conflictOrLatest(0, id, (latest) => latest.status === status)
    if (conflict) return conflict
    this.outbox.kick()
    return this.findOne(id)
  }

  async close(id: string, body: { fixNote?: string; photos?: string[]; closedAt?: string }, context?: IssueContext) {
    const fixNote = body.fixNote === undefined ? undefined : normalizeText(body.fixNote, 'fixNote', 10_000)
    const photos = body.photos === undefined ? undefined : normalizeStringArray(body.photos, 'photos', 50)
    const requestedClosedAt = body.closedAt === undefined ? undefined : normalizeDate(body.closedAt, 'closedAt')
    if (requestedClosedAt === null) throw new BadRequestException('closedAt 必须是有效的日期时间字符串')
    const issue = await this.workflowIssue(id)
    if (!['managed', 'reference'].includes(issue.scope)) throw new BadRequestException('隐患 scope 非法，不能闭环')
    if (issue.status === 'closed') {
      const sameNote = fixNote === undefined || fixNote === (issue.fixNote ?? '')
      const samePhotos = photos === undefined || sameArray(photos, issue.photos)
      const sameTime = requestedClosedAt === undefined || (!!issue.closedAt && requestedClosedAt.getTime() === issue.closedAt.getTime())
      if (sameNote && samePhotos && sameTime) return issue
      throw new ConflictException('隐患已闭环，但重复 close 的 fixNote、photos 或 closedAt 与首次请求不一致')
    }
    if (issue.scope === 'managed') {
      if (issue.status !== 'review') throw new BadRequestException('仅待复查状态的隐患可以闭环')
      if (!issue.reviewed) throw new BadRequestException('隐患尚未人工复核，不能闭环')
      if (issue.rechecks.length < issue.recheckRequired) {
        throw new BadRequestException(`复查次数不足：已完成 ${issue.rechecks.length} 次，要求至少 ${issue.recheckRequired} 次`)
      }
      if (issue.stage !== 'done') throw new BadRequestException('闭环阶段尚未完成，不能闭环')
      if (!issue.fixNote?.trim() && !fixNote) throw new BadRequestException('缺少整改记录，请填写 fixNote 后再闭环')
    }
    const closedAt = requestedClosedAt ?? new Date()
    const data: Prisma.IssueUncheckedUpdateInput = { status: 'closed', closedAt }
    if (fixNote !== undefined) data.fixNote = fixNote
    if (photos !== undefined) data.photos = photos
    const where: Prisma.IssueWhereInput = { id, status: issue.status, scope: issue.scope, deletedAt: null }
    if (issue.scope === 'managed') {
      Object.assign(where, {
        reviewed: true,
        stage: 'done',
        recheckRequired: issue.recheckRequired,
        rechecks: { equals: issue.rechecks },
      })
    }
    const operationKey = `issue:close:${id}:${randomUUID()}`
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.issue.updateMany({ where, data })
      if (!result.count) return false
      await this.audit.record(tx, {
        issueId: id,
        ...this.context(context),
        action: 'issue.close',
        from: { status: issue.status },
        to: { status: 'closed', closedAt },
        detail: { fixNote, photos },
      })
      await this.outbox.enqueue(tx, 'knowledge.issue.sync', `${operationKey}:knowledge`, { issueIds: [id] })
      return true
    })
    const conflict = updated ? null : await this.conflictOrLatest(0, id, (latest) =>
      latest.status === 'closed' &&
      (fixNote === undefined || latest.fixNote === fixNote) &&
      (photos === undefined || sameArray(latest.photos, photos)) &&
      (requestedClosedAt === undefined || (!!latest.closedAt && latest.closedAt.getTime() === closedAt.getTime())),
    )
    if (conflict) return conflict
    this.outbox.kick()
    return this.findOne(id)
  }

  async correctEvidence(
    id: string,
    body: { fixNote?: string; photos?: string[]; reason?: string },
    context?: IssueContext,
  ) {
    const reason = normalizeText(body?.reason, 'reason', 2_000, true)!
    const hasNote = Object.prototype.hasOwnProperty.call(body, 'fixNote')
    const hasPhotos = Object.prototype.hasOwnProperty.call(body, 'photos')
    if (!hasNote && !hasPhotos) throw new BadRequestException('证据更正至少提供 fixNote 或 photos')
    const fixNote = hasNote ? normalizeText(body.fixNote, 'fixNote', 10_000) : undefined
    const photos = hasPhotos ? normalizeStringArray(body.photos, 'photos', 50) : undefined
    const issue = await this.workflowIssue(id)
    if (issue.status !== 'closed') throw new BadRequestException('只有已闭环隐患需要使用证据更正命令')
    const data: Prisma.IssueUncheckedUpdateInput = {}
    if (hasNote) data.fixNote = fixNote
    if (hasPhotos) data.photos = photos
    const operationKey = `issue:evidence:${id}:${randomUUID()}`
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.issue.updateMany({ where: { id, status: 'closed', deletedAt: null }, data })
      if (!result.count) throw new ConflictException('隐患状态已变化，证据更正未执行')
      await this.audit.record(tx, {
        issueId: id,
        ...this.context(context),
        action: 'issue.evidence.correct',
        from: { fixNote: issue.fixNote, photos: issue.photos },
        to: { fixNote: hasNote ? fixNote : issue.fixNote, photos: hasPhotos ? photos : issue.photos },
        detail: { reason },
      })
      await this.outbox.enqueue(tx, 'knowledge.issue.sync', `${operationKey}:knowledge`, { issueIds: [id] })
    })
    this.outbox.kick()
    return this.findOne(id)
  }

  async markReviewed(id: string, context?: IssueContext) {
    const issue = await this.workflowIssue(id)
    if (issue.reviewed) return issue
    const operationKey = `issue:reviewed:${id}:${randomUUID()}`
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.issue.updateMany({ where: { id, reviewed: false, deletedAt: null }, data: { reviewed: true } })
      if (!result.count) return false
      await this.audit.record(tx, { issueId: id, ...this.context(context), action: 'issue.reviewed', from: false, to: true })
      await this.outbox.enqueue(tx, 'knowledge.issue.sync', `${operationKey}:knowledge`, { issueIds: [id] })
      return true
    })
    const conflict = updated ? null : await this.conflictOrLatest(0, id, (latest) => latest.reviewed)
    if (conflict) return conflict
    this.outbox.kick()
    return this.findOne(id)
  }

  async linkRegulation(id: string, regulationId?: string, context?: IssueContext) {
    if (!regulationId) throw new BadRequestException('缺少 regulationId')
    const [issue, regulation] = await Promise.all([
      this.workflowIssue(id),
      this.prisma.regulation.findUnique({ where: { id: regulationId } }),
    ])
    if (!regulation) throw new NotFoundException(`Regulation ${regulationId} not found`)
    const operationKey = `issue:regulation:${id}:${randomUUID()}`
    await this.prisma.$transaction(async (tx) => {
      await tx.issueRegulation.upsert({
        where: { issueId_regulationId: { issueId: id, regulationId } },
        create: { issueId: id, regulationId },
        update: {},
      })
      await this.audit.record(tx, {
        issueId: id,
        ...this.context(context),
        action: 'issue.regulation.link',
        to: regulationId,
        detail: { previousStatus: issue.status },
      })
      await this.outbox.enqueue(tx, 'knowledge.issue.sync', `${operationKey}:knowledge`, { issueIds: [id] })
    })
    this.outbox.kick()
    return this.findOne(id)
  }

  async unlinkRegulation(id: string, regulationId: string, context?: IssueContext) {
    await this.workflowIssue(id)
    const operationKey = `issue:regulation:${id}:${randomUUID()}`
    await this.prisma.$transaction(async (tx) => {
      await tx.issueRegulation.deleteMany({ where: { issueId: id, regulationId } })
      await this.audit.record(tx, { issueId: id, ...this.context(context), action: 'issue.regulation.unlink', from: regulationId })
      await this.outbox.enqueue(tx, 'knowledge.issue.sync', `${operationKey}:knowledge`, { issueIds: [id] })
    })
    this.outbox.kick()
    return this.findOne(id)
  }

  knowledgeDocs() {
    return this.prisma.knowledgeDoc.findMany({ select: { id: true, title: true, kind: true }, orderBy: { createdAt: 'desc' }, take: 200 })
  }

  private assertManagedWorkflow(issue: { scope: string; status: string; stage: string }) {
    if (issue.scope !== 'managed') throw new BadRequestException('其他车间的问题仅作参考，不能复查或推进闭环阶段')
    const historicalClosed = issue.status === 'closed' && issue.stage !== 'done'
    if (issue.status !== 'review' && !historicalClosed) {
      throw new BadRequestException('仅待复查状态，或已闭环但阶段未完成的历史隐患，可执行此操作')
    }
  }

  async recheck(
    id: string,
    input: boolean | { failed?: boolean; note?: string; photos?: string[]; checkedAt?: string } = {},
    context?: IssueContext,
  ) {
    const body = typeof input === 'boolean' ? { failed: input } : input
    if (body.failed !== undefined && typeof body.failed !== 'boolean') throw new BadRequestException('failed 必须是布尔值')
    const failed = body.failed === true
    const note = body.note === undefined ? '' : normalizeText(body.note, 'note', 5_000) ?? ''
    if (failed && !note) throw new BadRequestException('复查不合格必须填写 note，说明复发情况')
    const photos = normalizeStringArray(body.photos, 'photos', 50) ?? []
    const checkedAt = body.checkedAt === undefined ? new Date() : normalizeDate(body.checkedAt, 'checkedAt')
    if (!checkedAt) throw new BadRequestException('checkedAt 必须是有效日期')
    const issue = await this.workflowIssue(id)
    this.assertManagedWorkflow(issue)
    if (!failed && issue.rechecks.length >= issue.recheckRequired) return issue
    const rechecks = failed ? issue.rechecks : [...issue.rechecks, checkedAt.toISOString()]
    const allPassed = !failed && rechecks.length >= issue.recheckRequired
    const data: Prisma.IssueUncheckedUpdateInput = failed
      ? { recheckRequired: issue.recheckRequired + 1, stage: 'rechecking' }
      : { rechecks, ...(allPassed && issue.stage === 'rechecking' ? { stage: 'institutionalizing' } : {}) }
    const where: Prisma.IssueWhereInput = {
      id,
      scope: 'managed',
      status: issue.status,
      stage: issue.stage,
      recheckRequired: issue.recheckRequired,
      rechecks: { equals: issue.rechecks },
      deletedAt: null,
    }
    const operationKey = `issue:recheck:${id}:${randomUUID()}`
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.issue.updateMany({ where, data })
      if (!result.count) return false
      await tx.recheckRecord.create({
        data: {
          issueId: id,
          result: failed ? 'fail' : 'pass',
          pass: !failed,
          fail: failed,
          actor: this.context(context).actor,
          note,
          photos,
          checkedAt,
        },
      })
      await this.audit.record(tx, {
        issueId: id,
        ...this.context(context),
        action: 'issue.recheck',
        from: { recheckRequired: issue.recheckRequired, recheckCount: issue.rechecks.length, stage: issue.stage },
        to: {
          recheckRequired: failed ? issue.recheckRequired + 1 : issue.recheckRequired,
          recheckCount: rechecks.length,
          stage: allPassed && issue.stage === 'rechecking' ? 'institutionalizing' : data.stage ?? issue.stage,
        },
        detail: { result: failed ? 'fail' : 'pass', note, photos, checkedAt },
      })
      if (!failed) await tx.reminder.deleteMany({ where: { type: 'recheck', refId: { startsWith: `${id}#` } } })
      await this.outbox.enqueue(tx, 'knowledge.issue.sync', `${operationKey}:knowledge`, { issueIds: [id] })
      return true
    })
    const conflict = updated ? null : await this.conflictOrLatest(0, id, (latest) => failed
      ? latest.recheckRequired === issue.recheckRequired + 1 && latest.stage === 'rechecking'
      : latest.rechecks.length === rechecks.length &&
        latest.recheckRequired === issue.recheckRequired &&
        (!allPassed || issue.stage !== 'rechecking' || latest.stage === 'institutionalizing'),
    )
    if (conflict) return conflict
    this.outbox.kick()
    return this.findOne(id)
  }

  async advanceStage(id: string, body: { note?: string; linkedKnowledgeDocId?: string }, context?: IssueContext) {
    const issue = await this.workflowIssue(id)
    this.assertManagedWorkflow(issue)
    const index = STAGE_ORDER.indexOf(issue.stage as (typeof STAGE_ORDER)[number])
    if (index < 0 || index >= STAGE_ORDER.length - 1) throw new BadRequestException('该隐患已完成闭环，无需再推进阶段')
    if (issue.stage === 'rechecking' && issue.rechecks.length < issue.recheckRequired) {
      throw new BadRequestException('复查尚未全部合格，不能进入下一阶段')
    }
    const next = STAGE_ORDER[index + 1]
    const data: Prisma.IssueUncheckedUpdateInput = { stage: next }
    if (issue.stage === 'institutionalizing') {
      const note = body.note === undefined ? '' : normalizeText(body.note, 'note', 10_000) ?? ''
      const linkedKnowledgeDocId = body.linkedKnowledgeDocId === undefined || body.linkedKnowledgeDocId === null
        ? ''
        : normalizeText(body.linkedKnowledgeDocId, 'linkedKnowledgeDocId', 100) ?? ''
      if (!note && !linkedKnowledgeDocId) throw new BadRequestException('制度沉淀推进前至少填写 note 或 linkedKnowledgeDocId 一项')
      data.institutionNote = note || null
      data.linkedKnowledgeDocId = linkedKnowledgeDocId || null
    }
    const operationKey = `issue:stage:${id}:${randomUUID()}`
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.issue.updateMany({
        where: {
          id,
          scope: 'managed',
          status: issue.status,
          stage: issue.stage,
          recheckRequired: issue.recheckRequired,
          rechecks: { equals: issue.rechecks },
          deletedAt: null,
        },
        data,
      })
      if (!result.count) return false
      await this.audit.record(tx, {
        issueId: id,
        ...this.context(context),
        action: 'issue.stage',
        from: issue.stage,
        to: next,
        detail: issue.stage === 'institutionalizing' ? { note: data.institutionNote, linkedKnowledgeDocId: data.linkedKnowledgeDocId } : undefined,
      })
      await this.outbox.enqueue(tx, 'knowledge.issue.sync', `${operationKey}:knowledge`, { issueIds: [id] })
      return true
    })
    const conflict = updated ? null : await this.conflictOrLatest(0, id, (latest) => latest.stage === next &&
      (issue.stage !== 'institutionalizing' ||
        (latest.institutionNote === (data.institutionNote ?? null) && latest.linkedKnowledgeDocId === (data.linkedKnowledgeDocId ?? null))),
    )
    if (conflict) return conflict
    this.outbox.kick()
    return this.findOne(id)
  }

  async remove(id: string, context?: IssueContext) {
    const issue = await this.workflowIssue(id)
    const operationKey = `issue:remove:${id}:${randomUUID()}`
    await this.prisma.$transaction(async (tx) => {
      await tx.issue.update({ where: { id }, data: { deletedAt: new Date() } })
      await this.audit.record(tx, { issueId: id, ...this.context(context), action: 'issue.remove', from: null, to: 'recycle_bin' })
      await this.outbox.enqueue(tx, 'knowledge.issue.remove', `${operationKey}:knowledge`, { issueIds: [id] })
      await this.outbox.enqueue(tx, 'reminder.gridowner', `${operationKey}:reminder`, { name: issue.gridOwner })
    })
    this.outbox.kick()
    return this.findOne(id)
  }

  async restore(id: string, context?: IssueContext) {
    const issue = await this.findOne(id)
    if (!issue.deletedAt) return issue
    const operationKey = `issue:restore:${id}:${randomUUID()}`
    await this.prisma.$transaction(async (tx) => {
      const restored = await tx.issue.update({ where: { id }, data: { deletedAt: null } })
      await this.audit.record(tx, { issueId: id, ...this.context(context), action: 'issue.restore', from: 'recycle_bin', to: null })
      await this.outbox.enqueueIssueEffects(tx, restored, operationKey)
    })
    this.outbox.kick()
    return this.findOne(id)
  }

  async hardRemove(id: string, context?: IssueContext) {
    const issue = await this.findOne(id)
    if (!issue.deletedAt) throw new NotFoundException('该隐患不在回收站中，不能彻底删除')
    const operationKey = `issue:hard-remove:${id}:${randomUUID()}`
    const removed = await this.prisma.$transaction(async (tx) => {
      await tx.issueAnnotation.deleteMany({ where: { issueId: id } })
      const row = await tx.issue.delete({ where: { id } })
      await this.audit.record(tx, { issueId: id, ...this.context(context), action: 'issue.hard_remove', from: 'recycle_bin', to: null })
      await this.outbox.enqueue(tx, 'knowledge.issue.remove', `${operationKey}:knowledge`, { issueIds: [id] })
      return row
    })
    this.outbox.kick()
    return removed
  }
}
