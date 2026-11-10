const test = require('node:test')
const assert = require('node:assert/strict')
const { MetricsService, MetricsController } = require('../dist/modules/metrics/metrics.module.js')

const DAY = 86400000
const now = new Date('2026-11-09T00:00:00.000Z')
const start = new Date(now.getTime() - 7 * DAY)
function issue(id, overrides = {}) {
  return { id, scope: 'managed', isGood: false, deletedAt: null, foundAt: new Date('2026-11-05T00:00:00Z'), status: 'pending', riskLevel: 'general', deadline: null, closedAt: null, ...overrides }
}
function match(row, where = {}) {
  if (where.deletedAt === null && row.deletedAt !== null) return false
  if (where.isGood === false && row.isGood !== false) return false
  if (where.scope && row.scope !== where.scope) return false
  if (where.status) {
    if (typeof where.status === 'string' && row.status !== where.status) return false
    if (where.status.not && row.status === where.status.not) return false
  }
  for (const field of ['foundAt', 'deadline', 'closedAt']) {
    const condition = where[field]
    if (!condition) continue
    const value = row[field]
    if (condition.not === null && value === null) return false
    if (condition.gte && !(value >= condition.gte)) return false
    if (condition.lte && !(value <= condition.lte)) return false
    if (condition.lt && !(value < condition.lt)) return false
  }
  return true
}
function harness(rows) {
  const prisma = { issue: {
    async count({ where }) { return rows.filter((row) => match(row, where)).length },
    async findMany({ where }) { return rows.filter((row) => match(row, where)).map((row) => ({ closedAt: row.closedAt, deadline: row.deadline })) },
    async groupBy({ by, where }) {
      const field = by[0]; const counts = new Map()
      for (const row of rows.filter((item) => match(item, where))) counts.set(row[field], (counts.get(row[field]) ?? 0) + 1)
      return [...counts].map(([value, count]) => ({ [field]: value, _count: { _all: count } }))
    },
  } }
  return new MetricsService(prisma)
}

test('发现闭环与按期闭环使用各自分母，边界 foundAt/deadline 均为闭区间', async () => {
  const service = harness([
    issue('start-on-time', { foundAt: start, status: 'closed', deadline: new Date(start.getTime() + DAY), closedAt: start }),
    issue('end-open', { foundAt: now, deadline: now }),
    issue('late', { status: 'closed', deadline: new Date('2026-11-06T00:00:00Z'), closedAt: new Date('2026-11-07T00:00:00Z') }),
    issue('before', { foundAt: new Date(start.getTime() - 1), deadline: new Date(start.getTime() - 1) }),
    issue('good', { isGood: true, status: 'closed', deadline: now, closedAt: now }),
    issue('reference', { scope: 'reference', status: 'closed', deadline: now, closedAt: now }),
  ])
  const result = await service.safety({ start, end: now, scope: 'managed' })
  assert.equal(result.total, 3)
  assert.equal(result.closed, 2)
  assert.equal(result.open, 1)
  assert.equal(result.discoveredClosureRate, 66.67)
  assert.equal(result.dueTotal, 3)
  assert.equal(result.dueClosedOnTime, 1)
  assert.equal(result.dueClosureRate, 33.33)
  assert.equal(result.period.startInclusive, true)
  assert.equal(result.period.endInclusive, true)
  const all = await service.safety({ start, end: now, scope: 'all' })
  assert.equal(all.total, 4)
})

test('零分母返回 null，超期只算未闭环且 deadline 早于 generatedAt', async () => {
  const empty = await harness([]).safetyForDays(7, 'managed', now)
  assert.equal(empty.discoveredClosureRate, null)
  assert.equal(empty.dueClosureRate, null)
  const result = await harness([
    issue('overdue', { deadline: new Date(now.getTime() - 1) }),
    issue('not-yet', { deadline: now }),
    issue('closed', { status: 'closed', deadline: new Date(now.getTime() - 1), closedAt: now }),
  ]).safety({ start, end: now, scope: 'managed', now })
  assert.equal(result.overdue, 1)
  await assert.rejects(harness([]).safetyForDays(8, 'managed', now), /days/)
})

test('安全指标控制器注册 /metrics/safety 路由', () => {
  assert.equal(Reflect.getMetadata('path', MetricsController), 'metrics')
  assert.equal(Reflect.getMetadata('path', MetricsController.prototype.safety), 'safety')
})
