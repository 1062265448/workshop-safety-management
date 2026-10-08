import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma.service'

/** 允许客户端写入的字段白名单 */
const WRITABLE = [
  'title', 'description', 'locationId', 'categoryId', 'tagIds', 'riskLevel',
  'status', 'scope', 'source', 'sourceFile', 'reporter', 'assignee',
  'foundAt', 'deadline', 'closedAt', 'fixNote', 'photos',
  'recheckIntervalDays', 'rechecks',
] as const

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
  constructor(private readonly prisma: PrismaService) {}

  findAll(filters: { status?: string; categoryId?: string; locationId?: string; q?: string }) {
    const where: Prisma.IssueWhereInput = {}
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
    return this.prisma.issue.create({ data: pick(body) })
  }

  createBatch(items: Record<string, unknown>[]) {
    return this.prisma.$transaction(items.map((item) => this.prisma.issue.create({ data: pick(item) })))
  }

  update(id: string, body: Record<string, unknown>) {
    return this.prisma.issue.update({ where: { id }, data: pick(body) })
  }

  /** 记录一次防复发复查：追加完成时间，并清掉该隐患的复查提醒 */
  async recheck(id: string) {
    const issue = await this.findOne(id)
    if (issue.rechecks.length >= issue.recheckRequired) return issue
    const updated = await this.prisma.issue.update({
      where: { id },
      data: { rechecks: [...issue.rechecks, new Date().toISOString()] },
    })
    await this.prisma.reminder.deleteMany({ where: { type: 'recheck', refId: { startsWith: `${id}#` } } })
    return updated
  }

  async remove(id: string) {
    // 级联清理：参考件标注随隐患一并删除
    await this.prisma.issueAnnotation.deleteMany({ where: { issueId: id } })
    return this.prisma.issue.delete({ where: { id } })
  }
}
