import { Controller, Get, Param, Patch, Post } from '@nestjs/common'
import { Injectable } from '@nestjs/common'
import { Module } from '@nestjs/common'
import { PrismaService } from '../../prisma.service'

@Injectable()
export class RemindersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.reminder.findMany({ orderBy: { triggerAt: 'desc' } })
  }

  markRead(id: string) {
    return this.prisma.reminder.update({ where: { id }, data: { read: true } })
  }

  markDone(id: string) {
    return this.prisma.reminder.update({ where: { id }, data: { done: true, read: true } })
  }

  /** 由当前数据推导提醒：整改超期 + 检查计划到点（幂等，靠 [type, refId] 唯一约束） */
  async refresh() {
    const now = new Date()

    // 整改超期：仅成品车间（managed）未闭环且 deadline 已过；参考件不催办
    const overdue = await this.prisma.issue.findMany({
      where: { status: { not: 'closed' }, scope: 'managed', deadline: { lt: now } },
    })
    for (const issue of overdue) {
      await this.prisma.reminder.upsert({
        where: { type_refId: { type: 'overdue', refId: issue.id } },
        create: { type: 'overdue', refId: issue.id, title: `整改超期：${issue.title}`, triggerAt: issue.deadline! },
        update: {},
      })
    }

    // 检查计划到点：启用且已进入提醒窗口
    const plans = await this.prisma.inspectionPlan.findMany({ where: { enabled: true } })
    let planHits = 0
    for (const plan of plans) {
      const windowStart = plan.nextRunAt.getTime() - plan.remindBeforeMinutes * 60_000
      if (windowStart > now.getTime()) continue
      planHits += 1
      await this.prisma.reminder.upsert({
        where: { type_refId: { type: 'plan', refId: plan.id } },
        create: { type: 'plan', refId: plan.id, title: `检查计划：${plan.name}`, triggerAt: plan.nextRunAt },
        update: {},
      })
    }

    // 防复发复查到点：成品车间隐患，未完成规定次数，下一次复查时间已过
    // 复查节奏：发现时间 + 第 N 次 × 间隔天数（默认 7 天，可按隐患编辑）
    const recheckIssues = await this.prisma.issue.findMany({ where: { scope: 'managed' } })
    let recheckHits = 0
    for (const issue of recheckIssues) {
      const done = issue.rechecks.length
      if (done >= issue.recheckRequired) continue
      const interval = Math.max(1, issue.recheckIntervalDays) * 86_400_000
      const due = new Date(issue.foundAt.getTime() + (done + 1) * interval)
      if (due.getTime() > now.getTime()) continue
      recheckHits += 1
      const refId = `${issue.id}#${done + 1}`
      await this.prisma.reminder.upsert({
        where: { type_refId: { type: 'recheck', refId } },
        create: { type: 'recheck', refId, title: `防复发复查（第 ${done + 1}/${issue.recheckRequired} 次）：${issue.title}`, triggerAt: due },
        update: {},
      })
    }

    return { overdueIssues: overdue.length, duePlans: planHits, dueRechecks: recheckHits }
  }
}

@Controller('reminders')
export class RemindersController {
  constructor(private readonly svc: RemindersService) {}

  @Get()
  findAll() {
    return this.svc.findAll()
  }

  @Post('refresh')
  refresh() {
    return this.svc.refresh()
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string) {
    return this.svc.markRead(id)
  }

  @Patch(':id/done')
  markDone(@Param('id') id: string) {
    return this.svc.markDone(id)
  }
}

@Module({
  controllers: [RemindersController],
  providers: [RemindersService, PrismaService],
})
export class RemindersModule {}
