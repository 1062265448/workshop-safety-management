import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common'
import { Injectable } from '@nestjs/common'
import { Module } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma.service'

const WRITABLE = ['name', 'scope', 'frequency', 'nextRunAt', 'checklist', 'remindBeforeMinutes', 'enabled'] as const

function pick(body: Record<string, unknown>): Prisma.InspectionPlanUncheckedCreateInput {
  const data: Record<string, unknown> = {}
  for (const key of WRITABLE) if (body[key] !== undefined) data[key] = body[key]
  if (typeof data.nextRunAt === 'string') data.nextRunAt = new Date(data.nextRunAt as string)
  return data as Prisma.InspectionPlanUncheckedCreateInput
}

/** 按频率推进到下一个未来时间点（补跳已过去的周期） */
function advance(nextRunAt: Date, frequency: string): Date {
  const next = new Date(nextRunAt)
  const now = new Date()
  do {
    switch (frequency) {
      case 'daily':
        next.setDate(next.getDate() + 1)
        break
      case 'weekly':
        next.setDate(next.getDate() + 7)
        break
      case 'monthly':
        next.setMonth(next.getMonth() + 1)
        break
      case 'quarterly':
        next.setMonth(next.getMonth() + 3)
        break
      default:
        next.setDate(next.getDate() + 7)
    }
  } while (next.getTime() <= now.getTime())
  return next
}

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.inspectionPlan.findMany({
      orderBy: { nextRunAt: 'asc' },
      include: { executions: { orderBy: { executedAt: 'desc' }, take: 1 } },
    })
  }

  executions(id: string) {
    return this.prisma.planExecution.findMany({ where: { planId: id }, orderBy: { executedAt: 'desc' } })
  }

  /** 执行闭环：记台账 → 推进下一周期 → 清理该计划的提醒 */
  async complete(id: string, body: { executor?: string; note?: string; issueIds?: string[] }) {
    const plan = await this.prisma.inspectionPlan.findUnique({ where: { id } })
    if (!plan) throw new NotFoundException(`Plan ${id} not found`)
    const [, updated] = await this.prisma.$transaction([
      this.prisma.planExecution.create({
        data: { planId: id, executor: body.executor ?? '', note: body.note ?? '', issueIds: body.issueIds ?? [] },
      }),
      this.prisma.inspectionPlan.update({
        where: { id },
        data: { nextRunAt: advance(plan.nextRunAt, plan.frequency) },
      }),
      this.prisma.reminder.updateMany({
        where: { type: 'plan', refId: id },
        data: { done: true, read: true },
      }),
    ])
    return updated
  }

  create(body: Record<string, unknown>) {
    return this.prisma.inspectionPlan.create({ data: pick(body) })
  }

  update(id: string, body: Record<string, unknown>) {
    return this.prisma.inspectionPlan.update({ where: { id }, data: pick(body) })
  }

  remove(id: string) {
    return this.prisma.inspectionPlan.delete({ where: { id } })
  }
}

@Controller('plans')
export class PlansController {
  constructor(private readonly svc: PlansService) {}

  @Get()
  findAll() {
    return this.svc.findAll()
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.svc.create(body)
  }

  @Get(':id/executions')
  executions(@Param('id') id: string) {
    return this.svc.executions(id)
  }

  @Post(':id/complete')
  complete(@Param('id') id: string, @Body() body: { executor?: string; note?: string; issueIds?: string[] }) {
    return this.svc.complete(id, body)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.svc.update(id, body)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id)
  }
}

@Module({
  controllers: [PlansController],
  providers: [PlansService, PrismaService],
})
export class PlansModule {}
