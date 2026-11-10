import { Body, Controller, Get, Injectable, Module, NotFoundException, OnModuleDestroy, OnModuleInit, Param, Post, Query } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma.service'
import { KnowledgeModule, KnowledgeService } from '../knowledge/knowledge.module'
import { AssessmentsModule, AssessmentsService } from '../assessments/assessments.module'
import { Roles } from '../auth/auth.module'

export type OutboxType = 'knowledge.issue.sync' | 'knowledge.good.sync' | 'knowledge.issue.remove' | 'assessment.repeat' | 'reminder.gridowner'
type Handler = (payload: Record<string, unknown>) => Promise<unknown>

export interface IssueEffectInput {
  id: string
  title: string
  gridOwner?: string | null
  assignee?: string | null
  isGood: boolean
}

@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout
  private running = false
  private readonly handlers = new Map<OutboxType, Handler>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
    private readonly assessments: AssessmentsService,
  ) {
    this.registerHandler('knowledge.issue.sync', (payload) => this.knowledge.syncIssues(payload.issueIds as string[]))
    this.registerHandler('knowledge.good.sync', (payload) => this.knowledge.syncGoodDoc(payload.issueId as string))
    this.registerHandler('knowledge.issue.remove', (payload) => this.knowledge.removeIssueDocs(payload.issueIds as string[]))
    this.registerHandler('assessment.repeat', (payload) => this.assessments.recordRepeat(payload.issue as IssueEffectInput))
    this.registerHandler('reminder.gridowner', (payload) => this.refreshGridOwner(payload.name as string | null | undefined))
  }

  onModuleInit() {
    this.recoverProcessing().catch((error) => console.warn('[outbox] 恢复中断事件失败', error))
    this.timer = setInterval(() => { void this.processDue() }, 5_000)
    this.timer.unref()
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
  }

  private async recoverProcessing() {
    await this.prisma.outboxEvent.updateMany({
      where: { status: 'processing' },
      data: { status: 'pending', nextAttemptAt: new Date(), lastError: '服务重启，恢复处理中事件' },
    })
  }

  registerHandler(type: OutboxType, handler: Handler) {
    this.handlers.set(type, handler)
  }

  async enqueue(
    tx: Prisma.TransactionClient,
    type: OutboxType,
    key: string,
    payload: Record<string, unknown>,
    now = new Date(),
  ) {
    return tx.outboxEvent.create({
      data: {
        idempotencyKey: key,
        type,
        payload: payload as Prisma.InputJsonValue,
        status: 'pending',
        nextAttemptAt: now,
      },
    })
  }

  async enqueueIssueEffects(tx: Prisma.TransactionClient, issue: IssueEffectInput, operationKey: string) {
    const jobs: Array<Promise<unknown>> = [
      this.enqueue(tx, 'knowledge.issue.sync', `${operationKey}:knowledge`, { issueIds: [issue.id] }),
      this.enqueue(tx, 'reminder.gridowner', `${operationKey}:reminder`, { name: issue.gridOwner ?? null }),
    ]
    if (issue.isGood) jobs.push(this.enqueue(tx, 'knowledge.good.sync', `${operationKey}:good`, { issueId: issue.id }))
    else jobs.push(this.enqueue(tx, 'assessment.repeat', `${operationKey}:assessment`, { issue }))
    await Promise.all(jobs)
  }

  kick() {
    setImmediate(() => { void this.processDue().catch((error) => console.warn('[outbox] 即时处理失败', error)) })
  }

  async processDue(limit = 20) {
    if (this.running) return { claimed: 0, succeeded: 0, failed: 0 }
    this.running = true
    let succeeded = 0
    let failed = 0
    try {
      const candidates = await this.prisma.outboxEvent.findMany({
        where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: 'asc' },
        take: limit,
      })
      for (const candidate of candidates) {
        const claimed = await this.prisma.outboxEvent.updateMany({
          where: { id: candidate.id, status: 'pending', nextAttemptAt: candidate.nextAttemptAt },
          data: { status: 'processing' },
        })
        if (!claimed.count) continue
        try {
          const handler = this.handlers.get(candidate.type as OutboxType)
          if (!handler) throw new Error(`未注册的 Outbox 事件类型：${candidate.type}`)
          await handler(candidate.payload as Record<string, unknown>)
          await this.prisma.outboxEvent.update({
            where: { id: candidate.id },
            data: { status: 'succeeded', completedAt: new Date(), lastError: null },
          })
          succeeded += 1
        } catch (error) {
          const attempts = candidate.attempts + 1
          const terminal = attempts >= candidate.maxAttempts
          const delay = Math.min(3_600_000, 1_000 * 2 ** Math.min(attempts - 1, 20))
          await this.prisma.outboxEvent.update({
            where: { id: candidate.id },
            data: {
              status: terminal ? 'failed' : 'pending',
              attempts,
              lastError: (error as Error).message.slice(0, 4_000),
              nextAttemptAt: new Date(Date.now() + delay),
            },
          })
          failed += 1
        }
      }
      return { claimed: candidates.length, succeeded, failed }
    } finally {
      this.running = false
    }
  }

  failures(limit = 100) {
    return this.prisma.outboxEvent.findMany({
      where: { status: 'failed' },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    })
  }

  async retry(id: string) {
    const event = await this.prisma.outboxEvent.findUnique({ where: { id } })
    if (!event) throw new NotFoundException(`Outbox ${id} not found`)
    const updated = await this.prisma.outboxEvent.update({
      where: { id },
      data: { status: 'pending', attempts: 0, lastError: null, nextAttemptAt: new Date(), completedAt: null },
    })
    this.kick()
    return updated
  }

  private async refreshGridOwner(gridOwner?: string | null) {
    const name = gridOwner?.trim()
    if (!name) return
    const count = await this.prisma.issue.count({ where: { scope: 'managed', gridOwner: name, deletedAt: null, isGood: false } })
    const refId = `gridowner:${name}`
    if (count < 2) {
      await this.prisma.reminder.deleteMany({ where: { type: 'gridowner', refId } })
      return
    }
    const title = count >= 3
      ? `严重提醒：网格责任人「${name}」已在 ${count} 条成品车间隐患中重复出现，建议加倍考核并专项排查`
      : `网格责任人「${name}」已在 ${count} 条成品车间隐患中重复出现，请关注`
    await this.prisma.reminder.upsert({
      where: { type_refId: { type: 'gridowner', refId } },
      create: { type: 'gridowner', refId, title, triggerAt: new Date() },
      update: { title },
    })
  }
}

@Controller('outbox')
export class OutboxController {
  constructor(private readonly outbox: OutboxService) {}

  @Get('failures')
  @Roles('admin')
  failures(@Query('limit') limit?: string) {
    return this.outbox.failures(limit ? Number(limit) : 100)
  }

  @Post(':id/retry')
  @Roles('admin')
  retry(@Param('id') id: string) {
    return this.outbox.retry(id)
  }
}

@Module({
  imports: [KnowledgeModule, AssessmentsModule],
  controllers: [OutboxController],
  providers: [OutboxService, PrismaService],
  exports: [OutboxService],
})
export class OutboxModule {}
