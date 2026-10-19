import { Body, Controller, Delete, Get, Module, Param, Query } from '@nestjs/common'
import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../prisma.service'

/**
 * 考核周期：当月10日 06:00 ~ 次月10日 06:00
 * （简化：日期 >= 10 取本月10日起，< 10 取上月10日起）
 */
export function currentPeriod(now = new Date()): { start: Date; end: Date } {
  const start =
    now.getDate() >= 10
      ? new Date(now.getFullYear(), now.getMonth(), 10, 6, 0, 0)
      : new Date(now.getFullYear(), now.getMonth() - 1, 10, 6, 0, 0)
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 10, 6, 0, 0)
  return { start, end }
}

/** month=YYYY-MM → 该月10日 06:00 起的考核周期 */
function periodOfMonth(month?: string): { start: Date; end: Date } {
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number)
    const start = new Date(y, m - 1, 10, 6, 0, 0)
    return { start, end: new Date(y, m, 10, 6, 0, 0) }
  }
  return currentPeriod()
}

@Injectable()
export class AssessmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 查指定月份（该月10日起）周期内的考核记录 */
  list(month?: string) {
    const { start, end } = periodOfMonth(month)
    return this.prisma.assessment.findMany({
      where: { periodStart: { gte: start, lt: end } },
      orderBy: { createdAt: 'desc' },
    })
  }

  async remove(id: string) {
    const row = await this.prisma.assessment.findUnique({ where: { id } })
    if (!row) throw new NotFoundException(`Assessment ${id} not found`)
    return this.prisma.assessment.delete({ where: { id } })
  }

  /**
   * 网格责任人重复考核：同一责任人在成品车间隐患中出现
   * 2 次 → normal（提醒）；≥3 次 → double（加倍考核）。
   * 同人同周期同等级去重：已存在则更新 note，不重复插入。
   */
  async recordRepeat(issue: { id: string; title: string; gridOwner?: string | null; assignee?: string | null }) {
    const owner = issue.gridOwner?.trim() || issue.assignee?.trim()
    const name = issue.gridOwner?.trim()
    if (!owner || !name) return
    const count = await this.prisma.issue.count({
      where: { scope: 'managed', gridOwner: name, deletedAt: null },
    })
    if (count < 2) return
    const level = count >= 3 ? 'double' : 'normal'
    const { start, end } = currentPeriod()
    const note = `网格责任人「${name}」已在 ${count} 条成品车间隐患中重复出现${level === 'double' ? '，建议加倍考核并专项排查' : '，予以提醒'}`
    const existing = await this.prisma.assessment.findFirst({
      where: { owner, level, periodStart: { gte: start, lt: end } },
    })
    if (existing) {
      return this.prisma.assessment.update({
        where: { id: existing.id },
        data: { note, issueId: issue.id, issueTitle: issue.title },
      })
    }
    return this.prisma.assessment.create({
      data: { issueId: issue.id, issueTitle: issue.title, owner, level, periodStart: start, periodEnd: end, note },
    })
  }
}

@Controller('assessments')
export class AssessmentsController {
  constructor(private readonly svc: AssessmentsService) {}

  @Get()
  list(@Query('month') month?: string) {
    return this.svc.list(month)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id)
  }
}

@Module({
  controllers: [AssessmentsController],
  providers: [AssessmentsService, PrismaService],
  exports: [AssessmentsService],
})
export class AssessmentsModule {}
