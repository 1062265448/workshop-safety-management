import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma.service'
import { MetricsService, MetricScope } from '../metrics/metrics.module'

const ISSUE_STATUSES = new Set(['pending', 'fixing', 'review', 'closed'])
const SCOPES = new Set(['managed', 'reference'])
const RISK_LEVELS = new Set(['general', 'major', 'critical', 'immediate'])

function text(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new BadRequestException(`${name} 不能为空`)
    return undefined
  }
  if (typeof value !== 'string') throw new BadRequestException(`${name} 必须是字符串`)
  const cleaned = value.trim()
  if (required && !cleaned) throw new BadRequestException(`${name} 不能为空`)
  if (cleaned.length > max) throw new BadRequestException(`${name} 不能超过 ${max} 个字符`)
  return cleaned || undefined
}

function limit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw new BadRequestException(`limit 必须是 1～${max} 的整数`)
  }
  return Number(value)
}

function enumValue(value: unknown, name: string, allowed: Set<string>): string | undefined {
  const cleaned = text(value, name, 40)
  if (cleaned && !allowed.has(cleaned)) throw new BadRequestException(`${name} 不在允许列表中`)
  return cleaned
}

function dateValue(value: unknown, name: string): Date | undefined {
  const cleaned = text(value, name, 60)
  if (!cleaned) return undefined
  const date = new Date(cleaned)
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${name} 必须是有效日期`)
  return date
}

const ISSUE_SUMMARY_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  scope: true,
  stage: true,
  riskLevel: true,
  reviewed: true,
  foundAt: true,
  deadline: true,
  closedAt: true,
  recheckRequired: true,
  rechecks: true,
} as const

/** OpenAI 兼容工具定义；名称和参数由服务端固定，模型不能提供 SQL、URL 或文件路径。 */
export const AGENT_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_issues',
      description: '按关键词、状态、范围、风险和复核状态检索隐患摘要，最多返回20条。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 200 },
          status: { type: 'string', enum: ['pending', 'fixing', 'review', 'closed'] },
          scope: { type: 'string', enum: ['managed', 'reference'] },
          riskLevel: { type: 'string', enum: ['general', 'major', 'critical', 'immediate'] },
          reviewed: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_issue',
      description: '按隐患ID读取一条隐患的业务字段、复查摘要和法规依据，不返回照片及个人敏感字段。',
      parameters: {
        type: 'object',
        properties: { issueId: { type: 'string', maxLength: 100 } },
        required: ['issueId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'aggregate_safety_metrics',
      description: '用数据库确定性聚合安全指标。时间范围为[start,end]闭区间，省略表示全部历史；scope默认为managed，all表示全部。',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'ISO日期或日期时间，含边界' },
          end: { type: 'string', description: 'ISO日期或日期时间，含边界' },
          scope: { type: 'string', enum: ['managed', 'reference', 'all'] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_regulations',
      description: '检索法规制度的标题、条款号与内容摘要，最多返回8条。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 8 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
] as const

@Injectable()
export class AgentTools {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService = new MetricsService(prisma),
  ) {}

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'search_issues': return this.searchIssues(args)
      case 'get_issue': return this.getIssue(args)
      case 'aggregate_safety_metrics': return this.aggregateMetrics(args)
      case 'search_regulations': return this.searchRegulations(args)
      default: throw new BadRequestException(`不允许调用工具：${name}`)
    }
  }

  private async searchIssues(args: Record<string, unknown>) {
    const query = text(args.query, 'query', 200)
    const status = enumValue(args.status, 'status', ISSUE_STATUSES)
    const scope = enumValue(args.scope, 'scope', SCOPES)
    const riskLevel = enumValue(args.riskLevel, 'riskLevel', RISK_LEVELS)
    if (args.reviewed !== undefined && typeof args.reviewed !== 'boolean') {
      throw new BadRequestException('reviewed 必须是布尔值')
    }
    const take = limit(args.limit, 10, 20)
    const where: Prisma.IssueWhereInput = {
      deletedAt: null,
      ...(status ? { status } : {}),
      ...(scope ? { scope } : {}),
      ...(riskLevel ? { riskLevel } : {}),
      ...(args.reviewed !== undefined ? { reviewed: args.reviewed as boolean } : {}),
      ...(query ? { OR: [{ title: { contains: query } }, { description: { contains: query } }] } : {}),
    }
    const [total, items] = await Promise.all([
      this.prisma.issue.count({ where }),
      this.prisma.issue.findMany({ where, select: ISSUE_SUMMARY_SELECT, orderBy: { foundAt: 'desc' }, take }),
    ])
    return { total, returned: items.length, items }
  }

  private async getIssue(args: Record<string, unknown>) {
    const issueId = text(args.issueId, 'issueId', 100, true)!
    const issue = await this.prisma.issue.findFirst({
      where: { id: issueId, deletedAt: null },
      select: {
        ...ISSUE_SUMMARY_SELECT,
        fixNote: true,
        institutionNote: true,
        issueRegulations: { select: { regulation: { select: { id: true, title: true, articleNo: true, summary: true } } } },
      },
    })
    if (!issue) throw new NotFoundException('隐患不存在或已删除')
    const { issueRegulations, ...rest } = issue
    return { ...rest, regulations: issueRegulations.map((link) => link.regulation) }
  }

  private async aggregateMetrics(args: Record<string, unknown>) {
    const start = dateValue(args.start, 'start')
    const end = dateValue(args.end, 'end')
    if (start && end && start >= end) throw new BadRequestException('start 必须早于 end')
    const scope = (text(args.scope, 'scope', 20) ?? 'managed') as MetricScope
    const metrics = await this.metrics.safety({ start, end, scope })
    return {
      ...metrics,
      // 保留 Agent v1 契约：closureRate 为 0～1；页面新指标使用 0～100 的独立字段。
      metricVersion: 'safety-v1',
      closureRate: metrics.total ? Number((metrics.closed / metrics.total).toFixed(4)) : 0,
    }
  }

  private async searchRegulations(args: Record<string, unknown>) {
    const query = text(args.query, 'query', 200, true)!
    const take = limit(args.limit, 5, 8)
    const where: Prisma.RegulationWhereInput = {
      OR: [
        { title: { contains: query } },
        { articleNo: { contains: query } },
        { summary: { contains: query } },
      ],
    }
    const [total, items] = await Promise.all([
      this.prisma.regulation.count({ where }),
      this.prisma.regulation.findMany({
        where,
        select: { id: true, category: true, title: true, articleNo: true, summary: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take,
      }),
    ])
    return { total, returned: items.length, items }
  }
}
