import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma.service'
import { KnowledgeService } from '../knowledge/knowledge.module'
import { AssessmentsService } from '../assessments/assessments.module'

/** 允许客户端写入的字段白名单 */
const WRITABLE = [
  'title', 'description', 'locationId', 'categoryId', 'tagIds', 'riskLevel',
  'status', 'scope', 'source', 'sourceFile', 'reporter', 'assignee',
  'foundAt', 'deadline', 'closedAt', 'fixNote', 'photos',
  'recheckIntervalDays', 'rechecks',
  'team', 'gridOperator', 'gridOwner', 'systemOwner', 'systemCause',
  'causeType', 'countermeasureLevel', 'countermeasureReason',
  'institutionNote', 'linkedKnowledgeDocId',
  'reviewed',
] as const

/** 整改闭环阶段顺序（stage 只允许通过 stage/next 接口按序推进） */
const STAGE_ORDER = ['rechecking', 'institutionalizing', 'educating', 'executing', 'done'] as const

function pick(body: Record<string, unknown>): Prisma.IssueUncheckedCreateInput {
  const data: Record<string, unknown> = {}
  for (const key of WRITABLE) {
    if (body[key] !== undefined) data[key] = body[key]
  }
  for (const dkey of ['foundAt', 'deadline', 'closedAt'] as const) {
    if (typeof data[dkey] === 'string') data[dkey] = new Date(data[dkey] as string)
  }
  return data as Prisma.IssueUncheckedCreateInput
}

@Injectable()
export class IssuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
    private readonly assessments: AssessmentsService,
  ) {}

  /**
   * 戴明 94/6 根因校验（对策按 机制 → 技术 → 管理 的顺序想）：
   * - 对策层级仅 causeType=system 时有意义；
   * - 选 management 必须说明"为什么机制和技术做不到"（countermeasureReason）。
   * 更新时与库中现值合并校验（body 传 null 可清空）。
   */
  private checkCountermeasure(
    body: Record<string, unknown>,
    before?: { causeType: string | null; countermeasureLevel: string | null; countermeasureReason: string | null } | null,
  ) {
    const merged = {
      causeType: before?.causeType ?? null,
      countermeasureLevel: before?.countermeasureLevel ?? null,
      countermeasureReason: before?.countermeasureReason ?? null,
    }
    for (const key of ['causeType', 'countermeasureLevel', 'countermeasureReason'] as const) {
      if (body[key] !== undefined) merged[key] = body[key] as string | null
    }
    if (merged.countermeasureLevel && merged.causeType !== 'system') {
      throw new BadRequestException('对策层级仅在根因类别为「系统原因」时可填')
    }
    if (merged.countermeasureLevel === 'management' && !merged.countermeasureReason?.trim()) {
      throw new BadRequestException('对策层级选「管理」时，必须说明为什么机制和技术做不到（countermeasureReason）')
    }
  }

  findAll(filters: { status?: string; categoryId?: string; locationId?: string; q?: string; bin?: boolean }) {
    const where: Prisma.IssueWhereInput = {}
    // 回收站：默认只查正常条目；bin=1 时只查已删除条目
    where.deletedAt = filters.bin ? { not: null } : null
    if (filters.status) where.status = filters.status
    if (filters.categoryId) where.categoryId = filters.categoryId
    if (filters.locationId) where.locationId = filters.locationId
    if (filters.q) {
      where.OR = [
        { title: { contains: filters.q } },
        { description: { contains: filters.q } },
      ]
    }
    return this.prisma.issue.findMany({ where, orderBy: { createdAt: 'desc' } })
  }

  async findOne(id: string) {
    const issue = await this.prisma.issue.findUnique({ where: { id } })
    if (!issue) throw new NotFoundException(`Issue ${id} not found`)
    return issue
  }

  create(body: Record<string, unknown>) {
    this.checkCountermeasure(body)
    return this.prisma.issue.create({ data: pick(body) }).then(async (issue) => {
      await this.refreshGridOwnerReminder(issue.gridOwner)
      await this.assessments.recordRepeat(issue)
      void this.knowledge.syncIssues([issue.id]) // 增量索引：新问题实时进知识库
      return issue
    })
  }

  createBatch(items: Record<string, unknown>[]) {
    for (const item of items) this.checkCountermeasure(item)
    return this.prisma.$transaction(items.map((item) => this.prisma.issue.create({ data: pick(item) }))).then(async (created) => {
      for (const name of new Set(created.map((i) => i.gridOwner))) await this.refreshGridOwnerReminder(name)
      for (const issue of created) await this.assessments.recordRepeat(issue)
      void this.knowledge.syncIssues(created.map((i) => i.id)) // 批量导入一次嵌入，比逐条快一个数量级
      return created
    })
  }

  async update(id: string, body: Record<string, unknown>) {
    const before = await this.prisma.issue.findUnique({ where: { id } })
    this.checkCountermeasure(body, before)
    const issue = await this.prisma.issue.update({ where: { id }, data: pick(body) })
    for (const name of new Set([before?.gridOwner, issue.gridOwner])) await this.refreshGridOwnerReminder(name)
    await this.assessments.recordRepeat(issue)
    void this.knowledge.syncIssues([id]) // 内容/状态/分类变更同步进知识库
    return issue
  }

  /** 知识库条目下拉选项（制度沉淀阶段关联用；只读查询，不动知识库模块） */
  knowledgeDocs() {
    return this.prisma.knowledgeDoc.findMany({
      select: { id: true, title: true, kind: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
  }

  /**
   * 网格责任人重复提醒：同一责任人在成品车间隐患中出现
   * ≥2 次 → 提醒中心生成提醒；≥3 次 → 标题升级为严重提醒（加倍考核）。
   * 低于 2 次时提醒自动撤销；次数变化只更新标题，不重置已读状态。
   */
  private async refreshGridOwnerReminder(gridOwner?: string | null) {
    const name = gridOwner?.trim()
    if (!name) return
    const count = await this.prisma.issue.count({
      where: { scope: 'managed', gridOwner: name, deletedAt: null },
    })
    const refId = `gridowner:${name}`
    if (count < 2) {
      await this.prisma.reminder.deleteMany({ where: { type: 'gridowner', refId } })
      return
    }
    const title =
      count >= 3
        ? `严重提醒：网格责任人「${name}」已在 ${count} 条成品车间隐患中重复出现，建议加倍考核并专项排查`
        : `网格责任人「${name}」已在 ${count} 条成品车间隐患中重复出现，请关注`
    const existing = await this.prisma.reminder.findFirst({ where: { type: 'gridowner', refId } })
    if (existing) {
      if (existing.title !== title) {
        await this.prisma.reminder.update({ where: { id: existing.id }, data: { title, triggerAt: new Date() } })
      }
    } else {
      await this.prisma.reminder.create({ data: { type: 'gridowner', refId, title, triggerAt: new Date() } })
    }
  }

  /** 记录一次防复发复查：追加完成时间，并清掉该隐患的复查提醒；全部合格后进入「制度沉淀」阶段 */
  async recheck(id: string, failed = false) {
    const issue = await this.findOne(id)
    // 复发顺延：复查不合格 → 要求复查次数 +1，保持复查中阶段（整改没站住就继续盯）
    if (failed) {
      const updated = await this.prisma.issue.update({
        where: { id },
        data: { recheckRequired: issue.recheckRequired + 1, stage: 'rechecking' },
      })
      void this.knowledge.syncIssues([id])
      return updated
    }
    if (issue.rechecks.length >= issue.recheckRequired) return issue
    const rechecks = [...issue.rechecks, new Date().toISOString()]
    const allPassed = rechecks.length >= issue.recheckRequired
    const updated = await this.prisma.issue.update({
      where: { id },
      data: {
        rechecks,
        // 三次复查全部合格 → 自动进入「制度沉淀」阶段
        ...(allPassed && issue.stage === 'rechecking' ? { stage: 'institutionalizing' } : {}),
      },
    })
    await this.prisma.reminder.deleteMany({ where: { type: 'recheck', refId: { startsWith: `${id}#` } } })
    void this.knowledge.syncIssues([id]) // 复查次数写进知识库文档
    return updated
  }

  /**
   * 整改闭环阶段推进：rechecking → institutionalizing → educating → executing → done
   * 阶段按顺序锁定，前一步没完成后一步不能做；制度沉淀阶段可记录制度要点并关联知识库条目。
   */
  async advanceStage(id: string, body: { note?: string; linkedKnowledgeDocId?: string }) {
    const issue = await this.findOne(id)
    const idx = STAGE_ORDER.indexOf(issue.stage as (typeof STAGE_ORDER)[number])
    if (idx < 0 || idx >= STAGE_ORDER.length - 1) throw new BadRequestException('该隐患已完成闭环，无需再推进阶段')
    if (issue.stage === 'rechecking' && issue.rechecks.length < issue.recheckRequired) {
      throw new BadRequestException('复查尚未全部合格，不能进入下一阶段')
    }
    const data: Prisma.IssueUncheckedUpdateInput = { stage: STAGE_ORDER[idx + 1] }
    if (issue.stage === 'institutionalizing') {
      data.institutionNote = body.note?.trim() || null
      data.linkedKnowledgeDocId = body.linkedKnowledgeDocId || null
    }
    const updated = await this.prisma.issue.update({ where: { id }, data })
    void this.knowledge.syncIssues([id])
    return updated
  }

  /** 软删除：进回收站（标注保留），可从回收站恢复 */
  async remove(id: string) {
    const issue = await this.prisma.issue.findUnique({ where: { id } })
    if (!issue) throw new NotFoundException(`Issue ${id} not found`)
    const updated = await this.prisma.issue.update({ where: { id }, data: { deletedAt: new Date() } })
    await this.refreshGridOwnerReminder(issue.gridOwner)
    void this.knowledge.removeIssueDocs([id]) // 回收站条目退出知识库检索
    return updated
  }

  /** 回收站恢复 */
  async restore(id: string) {
    const issue = await this.prisma.issue.findUnique({ where: { id } })
    if (!issue) throw new NotFoundException(`Issue ${id} not found`)
    const updated = await this.prisma.issue.update({ where: { id }, data: { deletedAt: null } })
    await this.refreshGridOwnerReminder(issue.gridOwner)
    void this.knowledge.syncIssues([id])
    return updated
  }

  /** 彻底删除：仅限回收站中的条目；级联清理标注，不可恢复 */
  async hardRemove(id: string) {
    const issue = await this.prisma.issue.findUnique({ where: { id } })
    if (!issue) throw new NotFoundException(`Issue ${id} not found`)
    if (!issue.deletedAt) throw new NotFoundException('该隐患不在回收站中，不能彻底删除')
    await this.prisma.issueAnnotation.deleteMany({ where: { issueId: id } })
    void this.knowledge.removeIssueDocs([id])
    return this.prisma.issue.delete({ where: { id } })
  }
}
