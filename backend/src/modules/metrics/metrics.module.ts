import { BadRequestException, Controller, Get, Injectable, Module, Query } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma.service'

export type MetricScope = 'managed' | 'reference' | 'all'
export interface MetricRange { start?: Date; end?: Date; scope?: MetricScope; now?: Date }

const DAY_MS = 86_400_000
const percent = (numerator: number, denominator: number): number | null =>
  denominator ? Number((numerator * 100 / denominator).toFixed(2)) : null

@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async safetyForDays(days: number, scope: MetricScope = 'managed', now = new Date()) {
    if (![7, 30, 90].includes(days)) throw new BadRequestException('days 仅支持 7、30、90')
    const start = new Date(now.getTime() - days * DAY_MS)
    return this.safety({ start, end: now, scope, now })
  }

  async safety(range: MetricRange) {
    const { start, end } = range
    const scope = range.scope ?? 'managed'
    if (!['managed', 'reference', 'all'].includes(scope)) throw new BadRequestException('scope 仅支持 managed、reference、all')
    if (start && Number.isNaN(start.getTime())) throw new BadRequestException('start 必须是有效日期')
    if (end && Number.isNaN(end.getTime())) throw new BadRequestException('end 必须是有效日期')
    if (start && end && start > end) throw new BadRequestException('start 必须早于或等于 end')
    const now = range.now ?? new Date()
    const scopeWhere: Prisma.IssueWhereInput = {
      deletedAt: null,
      isGood: false,
      ...(scope !== 'all' ? { scope } : {}),
    }
    const foundAt = {
      ...(start ? { gte: start } : {}),
      ...(end ? { lte: end } : {}),
    }
    const where: Prisma.IssueWhereInput = {
      ...scopeWhere,
      ...((start || end) ? { foundAt } : {}),
    }
    const deadline = {
      ...(start ? { gte: start } : {}),
      ...(end ? { lte: end } : {}),
    }
    const dueWhere: Prisma.IssueWhereInput = {
      ...scopeWhere,
      ...((start || end) ? { deadline } : { deadline: { not: null } }),
    }

    const [total, closed, overdue, dueTotal, dueClosedOnTime, byStatus, byRisk] = await Promise.all([
      this.prisma.issue.count({ where }),
      this.prisma.issue.count({ where: { ...where, status: 'closed' } }),
      this.prisma.issue.count({ where: { ...where, status: { not: 'closed' }, deadline: { lt: now } } }),
      this.prisma.issue.count({ where: dueWhere }),
      this.prisma.issue.findMany({
        where: { ...dueWhere, status: 'closed', closedAt: { not: null } },
        select: { closedAt: true, deadline: true },
      }).then((rows) => rows.filter((row) => row.deadline && row.closedAt && row.closedAt <= row.deadline).length),
      this.prisma.issue.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.issue.groupBy({ by: ['riskLevel'], where, _count: { _all: true } }),
    ])

    return {
      metricVersion: 'safety-v2',
      generatedAt: now.toISOString(),
      period: {
        start: start?.toISOString() ?? null,
        end: end?.toISOString() ?? null,
        startInclusive: true,
        endInclusive: true,
      },
      scope,
      total,
      closed,
      open: total - closed,
      discoveredClosureRate: percent(closed, total),
      dueTotal,
      dueClosedOnTime,
      dueClosureRate: percent(dueClosedOnTime, dueTotal),
      overdue,
      byStatus: Object.fromEntries(['pending', 'fixing', 'review', 'closed'].map((status) => [
        status, byStatus.find((row) => row.status === status)?._count._all ?? 0,
      ])),
      byRiskLevel: Object.fromEntries(['general', 'major', 'critical', 'immediate'].map((riskLevel) => [
        riskLevel, byRisk.find((row) => row.riskLevel === riskLevel)?._count._all ?? 0,
      ])),
    }
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('safety')
  safety(@Query('days') days = '7', @Query('scope') scope: MetricScope = 'managed') {
    const parsed = Number(days)
    if (!Number.isInteger(parsed)) throw new BadRequestException('days 仅支持 7、30、90')
    if (!['managed', 'reference', 'all'].includes(scope)) throw new BadRequestException('scope 仅支持 managed、reference、all')
    return this.metrics.safetyForDays(parsed, scope)
  }
}

@Module({
  controllers: [MetricsController],
  providers: [MetricsService, PrismaService],
  exports: [MetricsService],
})
export class MetricsModule {}
