import { BadRequestException } from '@nestjs/common'
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'

export const ISSUE_SCOPES = ['managed', 'reference'] as const
export const ISSUE_RISK_LEVELS = ['general', 'major', 'critical', 'immediate'] as const
export const ISSUE_SOURCES = ['manual', 'pptx', 'docx', 'xlsx'] as const
export const ISSUE_CAUSE_TYPES = ['system', 'individual'] as const
export const ISSUE_COUNTERMEASURE_LEVELS = ['mechanism', 'technical', 'management'] as const

const COMMON_FIELDS = [
  'title', 'description', 'locationId', 'categoryId', 'tagIds', 'riskLevel',
  'scope', 'source', 'sourceFile', 'reporter', 'assignee',
  'foundAt', 'deadline', 'fixNote', 'photos', 'recheckIntervalDays',
  'team', 'gridOperator', 'gridOwner', 'systemOwner', 'systemCause',
  'causeType', 'countermeasureLevel', 'countermeasureReason',
  'institutionNote', 'linkedKnowledgeDocId', 'isGood',
  'aiCategory', 'aiRiskLevel', 'aiCauseType', 'aiSuggestion',
] as const

export const CREATE_FIELDS = [...COMMON_FIELDS, 'reviewed'] as const
export const UPDATE_FIELDS = COMMON_FIELDS.filter((field) => field !== 'scope')
export const PATCH_STATE_FIELDS = ['scope', 'status', 'stage', 'closedAt', 'rechecks', 'reviewed'] as const

const STRING_LIMITS: Record<string, number> = {
  title: 200,
  description: 10_000,
  locationId: 100,
  categoryId: 100,
  riskLevel: 32,
  scope: 32,
  source: 32,
  sourceFile: 500,
  reporter: 200,
  assignee: 200,
  fixNote: 10_000,
  team: 100,
  gridOperator: 200,
  gridOwner: 200,
  systemOwner: 200,
  systemCause: 10_000,
  causeType: 32,
  countermeasureLevel: 32,
  countermeasureReason: 5_000,
  institutionNote: 10_000,
  linkedKnowledgeDocId: 100,
  aiCategory: 200,
  aiRiskLevel: 32,
  aiCauseType: 32,
  aiSuggestion: 5_000,
}

const NULLABLE_STRINGS = new Set([
  'locationId', 'categoryId', 'sourceFile', 'assignee', 'fixNote', 'team',
  'gridOperator', 'gridOwner', 'systemOwner', 'systemCause', 'causeType',
  'countermeasureLevel', 'countermeasureReason', 'institutionNote',
  'linkedKnowledgeDocId', 'aiCategory', 'aiRiskLevel', 'aiCauseType', 'aiSuggestion',
])

export function normalizeText(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new BadRequestException(`${name} 不能为空`)
    return undefined
  }
  if (typeof value !== 'string') throw new BadRequestException(`${name} 必须是字符串`)
  const cleaned = value.trim()
  if (required && !cleaned) throw new BadRequestException(`${name} 不能为空`)
  if (cleaned.length > max) throw new BadRequestException(`${name} 不能超过 ${max} 个字符`)
  return cleaned
}

export function normalizeDate(value: unknown, name: string): Date | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' && !(value instanceof Date)) {
    throw new BadRequestException(`${name} 必须是有效日期`)
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${name} 必须是有效日期`)
  return date
}

export function normalizeStringArray(value: unknown, name: string, max = 50): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || item.length > 1_000)) {
    throw new BadRequestException(`${name} 必须是最多 ${max} 项的字符串数组，单项不超过 1000 字`)
  }
  return value.map((item) => item.trim())
}

function enumValue(value: unknown, name: string, allowed: readonly string[]): unknown {
  if (value === undefined || value === null) return value
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new BadRequestException(`${name} 不在允许列表中：${allowed.join('、')}`)
  }
  return value
}

function assertObject(body: unknown, label: string): asserts body is Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException(`${label} 必须是对象`)
  }
}

export function assertPatchFields(body: unknown): asserts body is Record<string, unknown> {
  assertObject(body, '请求体')
  const forbidden = PATCH_STATE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field))
  if (forbidden.length) {
    throw new BadRequestException(`通用 PATCH 禁止修改状态机字段：${forbidden.join('、')}；请使用专用命令接口`)
  }
}

export function normalizeIssueInput(
  body: unknown,
  mode: 'create' | 'update',
  label = 'issue',
): Prisma.IssueUncheckedCreateInput {
  assertObject(body, label)
  const fields = mode === 'create' ? CREATE_FIELDS : UPDATE_FIELDS
  const data: Record<string, unknown> = {}
  for (const key of fields) {
    if (body[key] !== undefined) data[key] = body[key]
  }

  if (mode === 'create') {
    const title = normalizeText(body.title, `${label}.title`, STRING_LIMITS.title, true)
    data.title = title
  } else if (data.title !== undefined) {
    data.title = normalizeText(data.title, `${label}.title`, STRING_LIMITS.title, true)
  }

  for (const [key, max] of Object.entries(STRING_LIMITS)) {
    if (key === 'title' || data[key] === undefined) continue
    if (data[key] === null) {
      if (!NULLABLE_STRINGS.has(key)) throw new BadRequestException(`${label}.${key} 不能为 null`)
      continue
    }
    data[key] = normalizeText(data[key], `${label}.${key}`, max)
  }

  for (const [key, max] of [['tagIds', 100], ['photos', 50]] as const) {
    if (data[key] !== undefined) data[key] = normalizeStringArray(data[key], `${label}.${key}`, max)
  }
  for (const key of ['foundAt', 'deadline'] as const) {
    if (data[key] === undefined) continue
    const date = normalizeDate(data[key], `${label}.${key}`)
    if (key === 'foundAt' && date === null) delete data[key]
    else data[key] = date
  }
  if (data.recheckIntervalDays !== undefined &&
    (!Number.isInteger(data.recheckIntervalDays) || Number(data.recheckIntervalDays) < 1 || Number(data.recheckIntervalDays) > 365)) {
    throw new BadRequestException(`${label}.recheckIntervalDays 必须是 1～365 的整数`)
  }
  for (const key of ['reviewed', 'isGood'] as const) {
    if (data[key] !== undefined && typeof data[key] !== 'boolean') {
      throw new BadRequestException(`${label}.${key} 必须是布尔值`)
    }
  }

  enumValue(data.riskLevel, `${label}.riskLevel`, ISSUE_RISK_LEVELS)
  enumValue(data.scope, `${label}.scope`, ISSUE_SCOPES)
  enumValue(data.source, `${label}.source`, ISSUE_SOURCES)
  enumValue(data.causeType, `${label}.causeType`, ISSUE_CAUSE_TYPES)
  enumValue(data.countermeasureLevel, `${label}.countermeasureLevel`, ISSUE_COUNTERMEASURE_LEVELS)
  enumValue(data.aiRiskLevel, `${label}.aiRiskLevel`, ISSUE_RISK_LEVELS)
  enumValue(data.aiCauseType, `${label}.aiCauseType`, ISSUE_CAUSE_TYPES)

  if (mode === 'create') {
    data.status = 'pending'
    data.stage = 'rechecking'
    data.closedAt = null
    data.rechecks = []
  }
  return data as Prisma.IssueUncheckedCreateInput
}

export function normalizeIdempotencyKey(value: unknown, name = 'idempotencyKey'): string {
  return normalizeText(value, name, 300, true)!
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export function checkCountermeasure(
  body: Record<string, unknown>,
  before?: { causeType: string | null; countermeasureLevel: string | null; countermeasureReason: string | null } | null,
  label = 'issue',
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
    throw new BadRequestException(`${label}：对策层级仅在根因类别为「系统原因」时可填`)
  }
  if (merged.countermeasureLevel === 'management' && !merged.countermeasureReason?.trim()) {
    throw new BadRequestException(`${label}：对策层级选「管理」时，必须说明为什么机制和技术做不到（countermeasureReason）`)
  }
}
