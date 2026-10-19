import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma.service'
import { KnowledgeService } from '../knowledge/knowledge.module'

/** 允许客户端写入的字段白名单 */
const WRITABLE = [
  'title', 'description', 'locationId', 'categoryId', 'tagIds', 'riskLevel',
  'status', 'scope', 'source', 'sourceFile', 'reporter', 'assignee',
  'foundAt', 'deadline', 'closedAt', 'fixNote', 'photos',
  'recheckIntervalDays', 'rechecks',
  'team', 'gridOperator', 'gridOwner', 'systemOwner', 'systemCause',
  'reviewed',
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
  ) {}

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
    return this.prisma.issue.create({ data: pick(body) }).then(async (issue) => {
      await this.refreshGridOwnerReminder(issue.gridOwner)
      void this.knowledge.syncIssues([issue.id]) // 增量索引：新问题实时进知识库
      return issue
    })
  }

  createBatch(items: Record<string, unknown>[]) {
    return this.prisma.$transaction(items.map((item) => this.prisma.issue.create({ data: pick(item) }))).then(async (created) => {
      for (const name of new Set(created.map((i) => i.gridOwner))) await this.refreshGridOwnerReminder(name)
      void this.knowledge.syncIssues(created.map((i) => i.id)) // 批量导入一次嵌入，比逐条快一个数量级
      return created
    })
  }

  async update(id: string, body: Record<string, unknown>) {
    const before = await this.prisma.issue.findUnique({ where: { id } })
    const issue = await this.prisma.issue.update({ where: { id }, data: pick(body) })
    for (const name of new Set([before?.gridOwner, issue.gridOwner])) await this.refreshGridOwnerReminder(name)
    void this.knowledge.syncIssues([id]) // 内容/状态/分类变更同步进知识库
    return issue
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

  /** 记录一次防复发复查：追加完成时间，并清掉该隐患的复查提醒 */
  async recheck(id: string) {
    const issue = await this.findOne(id)
    if (issue.rechecks.length >= issue.recheckRequired) return issue
    const updated = await this.prisma.issue.update({
      where: { id },
      data: { rechecks: [...issue.rechecks, new Date().toISOString()] },
    })
    await this.prisma.reminder.deleteMany({ where: { type: 'recheck', refId: { startsWith: `${id}#` } } })
    void this.knowledge.syncIssues([id]) // 复查次数写进知识库文档
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
