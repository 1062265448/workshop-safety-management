import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma.service'
import { OutboxService } from '../outbox/outbox.module'
import { AuditService } from '../audit/audit.module'
import type { IssueContext } from '../issues/issues.service'
import { checkCountermeasure, normalizeIdempotencyKey, normalizeIssueInput, normalizeText, requestHash } from '../issues/issue-input'

export interface CreateImportBatchInput {
  items: Record<string, unknown>[]
  idempotencyKey: string
  source?: string
  externalMessageId?: string
  fileHash?: string
}

const REG_INCLUDE = { issueRegulations: { include: { regulation: true } } } as const
type IssueWithRegulations = Prisma.IssueGetPayload<{ include: typeof REG_INCLUDE }>
export type SafetyIssue = Omit<IssueWithRegulations, 'issueRegulations'> & { regulations: unknown[] }

export interface ImportBatchResponse {
  batchId: string
  status: 'succeeded'
  items: SafetyIssue[]
  createdCount: number
}

function serialize(issue: IssueWithRegulations): SafetyIssue {
  const { issueRegulations, ...rest } = issue
  return { ...rest, regulations: (issueRegulations ?? []).map((item) => item.regulation) }
}

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async createBatch(body: CreateImportBatchInput, context?: IssueContext): Promise<ImportBatchResponse> {
    if (!body || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 500) {
      throw new BadRequestException('items 必须是包含 1～500 条隐患的数组')
    }
    const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey)
    const source = normalizeText(body.source, 'source', 100) ?? ''
    const externalMessageId = normalizeText(body.externalMessageId, 'externalMessageId', 500)
    const fileHash = normalizeText(body.fileHash, 'fileHash', 512)
    const items = body.items.map((item, index) => {
      const normalized = normalizeIssueInput(item, 'create', `items[${index}]`)
      checkCountermeasure(normalized, null, `items[${index}]`)
      return normalized
    })
    const hash = requestHash({ items, source, externalMessageId: externalMessageId || null, fileHash: fileHash || null })

    const existing = await this.readExisting(idempotencyKey, hash)
    if (existing) return existing

    let committed: { batch: Prisma.ImportBatchGetPayload<Record<string, never>>; issues: IssueWithRegulations[] }
    try {
      committed = await this.prisma.$transaction(async (tx) => {
        const batch = await tx.importBatch.create({
          data: {
            idempotencyKey,
            requestHash: hash,
            source,
            externalMessageId: externalMessageId || null,
            fileHash: fileHash || null,
            status: 'processing',
            itemCount: items.length,
          },
        })
        const issues: IssueWithRegulations[] = []
        for (const [index, data] of items.entries()) {
          const issue = await tx.issue.create({ data, include: REG_INCLUDE })
          await tx.importItem.create({
            data: { batchId: batch.id, sourceKey: String(index), issueId: issue.id, status: 'succeeded' },
          })
          await this.audit.record(tx, {
            issueId: issue.id,
            actor: context?.actor || 'system',
            requestId: context?.requestId || null,
            action: 'issue.create',
            to: { status: issue.status, stage: issue.stage, scope: issue.scope },
            detail: { title: issue.title, batchId: batch.id, sourceKey: String(index), importKey: idempotencyKey },
          })
          await this.outbox.enqueueIssueEffects(tx, issue, `import:${batch.id}:${index}`)
          issues.push(issue)
        }
        const succeeded = await tx.importBatch.update({
          where: { id: batch.id },
          data: { status: 'succeeded', completedAt: new Date(), error: null },
        })
        return { batch: succeeded, issues }
      }, { maxWait: 10_000, timeout: 60_000 })
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        const replay = await this.readExisting(idempotencyKey, hash)
        if (replay) return replay
      }
      throw error
    }

    this.outbox.kick()
    return {
      batchId: committed.batch.id,
      status: 'succeeded',
      items: committed.issues.map(serialize),
      createdCount: committed.batch.itemCount,
    }
  }

  private async readExisting(idempotencyKey: string, hash: string): Promise<ImportBatchResponse | null> {
    const batch = await this.prisma.importBatch.findUnique({ where: { idempotencyKey } })
    if (!batch) return null
    if (batch.requestHash !== hash) throw new ConflictException('相同导入幂等键对应了不同的规范化请求内容')
    if (batch.status !== 'succeeded' || !batch.completedAt) {
      throw new ConflictException(`导入批次 ${batch.id} 尚未成功完成，不能重放`)
    }
    const links = await this.prisma.importItem.findMany({ where: { batchId: batch.id } })
    links.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey, undefined, { numeric: true }))
    if (links.length !== batch.itemCount || links.some((link) => link.status !== 'succeeded')) {
      throw new ConflictException(`导入批次 ${batch.id} 明细不完整，不能重放`)
    }
    const issues = await this.prisma.issue.findMany({ where: { id: { in: links.map((link) => link.issueId) } }, include: REG_INCLUDE })
    const byId = new Map(issues.map((issue) => [issue.id, issue]))
    const ordered = links.map((link) => byId.get(link.issueId))
    if (ordered.some((issue) => !issue)) throw new ConflictException(`导入批次 ${batch.id} 关联的隐患已不存在，不能重放`)
    return {
      batchId: batch.id,
      status: 'succeeded',
      items: (ordered as IssueWithRegulations[]).map(serialize),
      createdCount: batch.itemCount,
    }
  }
}
