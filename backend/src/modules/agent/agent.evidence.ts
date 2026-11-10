const DEFAULT_STRING_LIMIT = 2_000
const DEFAULT_ARRAY_LIMIT = 20
const DEFAULT_OBJECT_KEYS = 50
const DEFAULT_DEPTH = 8
const NUMBER_PATTERN = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`
const NUMBER_RE = new RegExp(`(?<![A-Za-z0-9])${NUMBER_PATTERN}(?![A-Za-z0-9])`, 'g')
const ID_KEY_RE = /(?:^id$|Id$|Ids$)/

export interface EvidenceStep {
  seq: number
  name: string
  status: string
  output: unknown
}

export interface EvidenceResult {
  ok: boolean
  reason: string
  evidenceSteps: number[]
  citedIds: string[]
  checkedNumbers: number[]
}

function numericTokens(value: string): number[] {
  return Array.from(value.matchAll(NUMBER_RE), (match) => Number(match[0].replace(/,/g, '')))
    .filter((number) => Number.isFinite(number))
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right))
}

/**
 * 截断供模型和轨迹使用的 JSON。ID 字段及数字不缩短；长文本中被截掉的
 * 数字和显式 ID 会尽量保留在标记中，避免验收信息因轨迹清理而丢失。
 */
export function truncateTraceValue(
  value: unknown,
  options: { stringLimit?: number; arrayLimit?: number; objectKeys?: number; depth?: number } = {},
): unknown {
  const stringLimit = Math.max(80, options.stringLimit ?? DEFAULT_STRING_LIMIT)
  const arrayLimit = Math.max(1, options.arrayLimit ?? DEFAULT_ARRAY_LIMIT)
  const objectKeys = Math.max(1, options.objectKeys ?? DEFAULT_OBJECT_KEYS)
  const maxDepth = Math.max(1, options.depth ?? DEFAULT_DEPTH)
  const seen = new WeakSet<object>()

  const visit = (input: unknown, key: string, depth: number): unknown => {
    if (input === null || input === undefined || typeof input === 'boolean') return input ?? null
    if (typeof input === 'number') return Number.isFinite(input) ? input : String(input)
    if (typeof input === 'bigint') return input.toString()
    if (input instanceof Date) return input.toISOString()
    if (typeof input === 'string') {
      if (ID_KEY_RE.test(key)) return input.slice(0, 256)
      if (input.length <= stringLimit) return input
      const preserved = Array.from(new Set([
        ...input.match(/(?:ID|编号)\s*[:：#]?\s*[A-Za-z0-9][A-Za-z0-9_-]{1,100}/gi) ?? [],
        ...input.match(NUMBER_RE) ?? [],
      ])).join('；')
      const suffix = `…[已截断${preserved ? `；保留：${preserved}` : ''}]`
      const headLength = Math.max(0, stringLimit - suffix.length)
      return `${input.slice(0, headLength)}${suffix}`.slice(0, stringLimit)
    }
    if (depth >= maxDepth) return '[已达到最大嵌套深度]'
    if (Array.isArray(input)) {
      const items = input.slice(0, arrayLimit).map((item) => visit(item, '', depth + 1))
      if (input.length > arrayLimit) items.push(`[其余 ${input.length - arrayLimit} 项已截断]`)
      return items
    }
    if (typeof input === 'object') {
      if (seen.has(input)) return '[循环引用已截断]'
      seen.add(input)
      const entries = Object.entries(input as Record<string, unknown>)
      const output: Record<string, unknown> = {}
      for (const [childKey, childValue] of entries.slice(0, objectKeys)) {
        output[childKey] = visit(childValue, childKey, depth + 1)
      }
      if (entries.length > objectKeys) output._truncatedKeys = entries.length - objectKeys
      return output
    }
    return String(input)
  }

  return visit(value, '', 0)
}

function collectIds(value: unknown, ids: Set<string>, key = ''): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, ids)
    return
  }
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    if (ID_KEY_RE.test(childKey) && typeof childValue === 'string' && childValue) ids.add(childValue)
    collectIds(childValue, ids, childKey)
  }
}

function metricValues(steps: EvidenceStep[], field: string): number[] {
  const values: number[] = []
  for (const step of steps) {
    const output = step.output as Record<string, unknown>
    const value = output?.[field]
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value)
  }
  return values
}

const METRIC_GAP = String.raw`[\s|*]*(?:有|为|是|达到|约为|约)?[\s|*:：]*`

function checkMetricClaims(
  answer: string,
  aggregateSteps: EvidenceStep[],
  field: string,
  expression: RegExp,
  sourceLabel = 'aggregate_safety_metrics 结果',
  transform: (value: number) => number = (value) => value,
): string | null {
  const expected = metricValues(aggregateSteps, field)
  for (const match of answer.matchAll(expression)) {
    const rawNumber = match[1] ?? match[2]
    if (rawNumber === undefined) continue
    const claimed = transform(Number(rawNumber.replace(/,/g, '')))
    if (!expected.some((value) => sameNumber(claimed, value))) {
      return `${field} 数值 ${rawNumber} 与 ${sourceLabel} 不一致`
    }
  }
  return null
}

function citedIds(answer: string): string[] {
  const ids = new Set<string>()
  for (const match of answer.matchAll(/(?:ID|编号)\s*[:：#]?\s*([A-Za-z0-9][A-Za-z0-9_-]{0,100})/gi)) {
    ids.add(match[1])
  }
  for (const match of answer.matchAll(/\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|c[a-z0-9]{19,}|(?:issue|regulation|reg)[-_][a-z0-9][a-z0-9_-]{1,100})\b/gi)) {
    ids.add(match[0])
  }
  return [...ids]
}

/** 只做确定性验收：成功工具证据、引用 ID、统计数值及关键指标口径。 */
export function validateEvidence(answer: string, steps: EvidenceStep[], question = ''): EvidenceResult {
  const successful = steps.filter((step) => step.status === 'succeeded')
  const evidenceSteps = successful.map((step) => step.seq)
  const checkedNumbers = numericTokens(answer)
  const citations = citedIds(answer)
  if (!successful.length) {
    return { ok: false, reason: '没有任何成功的只读工具证据', evidenceSteps, citedIds: citations, checkedNumbers }
  }

  const knownIds = new Set<string>()
  for (const step of successful) collectIds(step.output, knownIds)
  const unknownId = citations.find((id) => !knownIds.has(id))
  if (unknownId) {
    return { ok: false, reason: `引用的隐患或法规 ID 不在成功工具结果中：${unknownId}`, evidenceSteps, citedIds: citations, checkedNumbers }
  }

  const aggregateSteps = successful.filter((step) => step.name === 'aggregate_safety_metrics')
  // 是否必须聚合取决于用户意图；“统计范围”“本次仅统计”等回答说明不能替代问题分类。
  const statisticalQuestion = /统计|多少|闭环率|超期|数量|复发|新增|分布|占比/.test(question)
  const statisticalAnswer = /闭环率|隐患总数|本月新发现|新增隐患/.test(answer)
  const statistical = aggregateSteps.length > 0 || statisticalQuestion || statisticalAnswer
  if (!statistical) return { ok: true, reason: '引用 ID 均可由成功工具结果验证', evidenceSteps, citedIds: citations, checkedNumbers }
  if (!aggregateSteps.length) {
    return { ok: false, reason: '统计回答缺少 aggregate_safety_metrics 成功结果', evidenceSteps, citedIds: citations, checkedNumbers }
  }

  // “共 N 条”可能来自隐患或法规检索，必须能在任一成功工具的总数中找到。
  const countError = checkMetricClaims(
    answer,
    successful,
    'total',
    new RegExp(`(?:共|共计|总计|合计)${METRIC_GAP}(${NUMBER_PATTERN})\\s*条(?:隐患|记录)?`, 'g'),
    '成功工具返回的总数',
  )
  if (countError) return { ok: false, reason: countError, evidenceSteps, citedIds: citations, checkedNumbers }

  const checks: [string, RegExp][] = [
    // 明确的聚合指标只能使用聚合工具结果，不能与检索列表数量混用。
    ['total', new RegExp(`(?:隐患总数|总数|本月新发现|新发现|新增隐患)${METRIC_GAP}(${NUMBER_PATTERN})\\s*条?`, 'g')],
    ['closed', new RegExp(`(?:已闭环|(?<!应)(?<!按期)闭环(?:数|数量))${METRIC_GAP}(${NUMBER_PATTERN})\\s*条?`, 'g')],
    ['open', new RegExp(`(?:未闭环|未关闭|待闭环)(?:数|数量)?${METRIC_GAP}(${NUMBER_PATTERN})\\s*条?`, 'g')],
    ['overdue', new RegExp(`(?:已超期|超期(?:数|数量)?)${METRIC_GAP}(${NUMBER_PATTERN})\\s*条?`, 'g')],
  ]
  for (const [field, expression] of checks) {
    const error = checkMetricClaims(answer, aggregateSteps, field, expression)
    if (error) return { ok: false, reason: error, evidenceSteps, citedIds: citations, checkedNumbers }
  }

  // 闭环率既可用 0.4，也可用 40% 表示；两种口径都必须与 closureRate 字段一致。
  for (const match of answer.matchAll(new RegExp(`闭环率${METRIC_GAP}(${NUMBER_PATTERN})\\s*(%|％)?`, 'g'))) {
    const claimed = Number(match[1].replace(/,/g, ''))
    const percentage = Boolean(match[2])
    const expected = metricValues(aggregateSteps, 'closureRate').map((value) => percentage ? value * 100 : value)
    if (!expected.some((value) => sameNumber(claimed, value))) {
      return { ok: false, reason: `closureRate 数值 ${match[1]}${percentage ? '%' : ''} 与 aggregate_safety_metrics 结果不一致`, evidenceSteps, citedIds: citations, checkedNumbers }
    }
  }

  // 日期、列表序号和明细中的描述数字不是聚合指标，不参与数值白名单匹配。
  return { ok: true, reason: '统计指标数值和引用 ID 均与成功工具结果一致', evidenceSteps, citedIds: citations, checkedNumbers }
}
