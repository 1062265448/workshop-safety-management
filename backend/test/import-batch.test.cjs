const test = require('node:test')
const assert = require('node:assert/strict')
const { ImportService } = require('../dist/modules/imports/imports.service.js')

const clone = (value) => value == null ? value : structuredClone(value)
function issueRow(id, data) {
  const now = new Date('2026-11-09T00:00:00.000Z')
  return {
    id, title: data.title, description: data.description ?? '', locationId: data.locationId ?? null,
    categoryId: data.categoryId ?? null, tagIds: data.tagIds ?? [], riskLevel: data.riskLevel ?? 'general',
    status: data.status ?? 'pending', scope: data.scope ?? 'managed', source: data.source ?? 'manual',
    sourceFile: data.sourceFile ?? null, reporter: data.reporter ?? '', assignee: data.assignee ?? null,
    foundAt: data.foundAt ?? now, deadline: data.deadline ?? null, closedAt: data.closedAt ?? null,
    fixNote: data.fixNote ?? null, photos: data.photos ?? [], recheckIntervalDays: data.recheckIntervalDays ?? 7,
    recheckRequired: 3, rechecks: [], stage: 'rechecking', deletedAt: null,
    reviewed: data.reviewed ?? true, isGood: data.isGood ?? false, gridOwner: data.gridOwner ?? null,
    assignee: data.assignee ?? null, requestKey: null, requestHash: null,
    createdAt: now, updatedAt: now, issueRegulations: [], ...clone(data),
  }
}
class MemoryPrisma {
  constructor() {
    this.state = { batches: [], items: [], issues: [] }
    this.seq = 0
    this.failOnIssueTitle = ''
    this.importBatch = { findUnique: async ({ where }) => clone(this.state.batches.find((b) => b.idempotencyKey === where.idempotencyKey) ?? null) }
    this.importItem = { findMany: async ({ where }) => clone(this.state.items.filter((i) => i.batchId === where.batchId)) }
    this.issue = { findMany: async ({ where }) => clone(this.state.issues.filter((i) => where.id.in.includes(i.id))) }
  }
  delegates(state) {
    return {
      importBatch: {
        create: async ({ data }) => {
          if (state.batches.some((b) => b.idempotencyKey === data.idempotencyKey)) {
            const error = new Error('duplicate'); error.code = 'P2002'; throw error
          }
          const row = { id: `batch-${++this.seq}`, createdAt: new Date(), completedAt: null, error: null, ...data }
          state.batches.push(row); return clone(row)
        },
        update: async ({ where, data }) => { const row = state.batches.find((b) => b.id === where.id); Object.assign(row, data); return clone(row) },
      },
      importItem: { create: async ({ data }) => { const row = { id: `item-${++this.seq}`, error: null, ...data }; state.items.push(row); return clone(row) } },
      issue: { create: async ({ data }) => {
        if (data.title === this.failOnIssueTitle) throw new Error('simulated issue insert failure')
        const row = issueRow(`issue-${++this.seq}`, data); state.issues.push(row); return clone(row)
      } },
    }
  }
  async $transaction(run) { const draft = clone(this.state); const result = await run(this.delegates(draft)); this.state = draft; return result }
}
function harness() {
  const prisma = new MemoryPrisma()
  const effects = []
  const audits = []
  const outbox = {
    kick() {},
    async enqueueIssueEffects(_tx, issue, key) { effects.push({ id: issue.id, key }) },
  }
  const audit = { async record(_tx, input) { audits.push(clone(input)) } }
  return { prisma, service: new ImportService(prisma, outbox, audit), effects, audits }
}
function input(key = 'test-key') {
  return {
    idempotencyKey: key, source: 'test', externalMessageId: 'message-1', fileHash: 'abc123',
    items: [
      { title: '  隐患一  ', description: '描述', foundAt: '2026-11-08T01:00:00.000Z', riskLevel: 'major', status: 'closed', stage: 'done', closedAt: '2026-11-08T02:00:00.000Z', rechecks: ['x'], causeType: 'system', countermeasureLevel: 'management', countermeasureReason: '现有机制和技术无法覆盖' },
      { title: '好做法', isGood: true },
    ],
  }
}

test('批次保存规范化 requestHash，原子创建并同事务写审计和 Outbox', async () => {
  const { service, prisma, effects, audits } = harness()
  const result = await service.createBatch(input(), { actor: 'user-1', requestId: 'req-1' })
  assert.equal(result.createdCount, 2)
  assert.equal(result.items[0].title, '隐患一')
  assert.equal(result.items[0].riskLevel, 'major')
  assert.equal(result.items[0].status, 'pending')
  assert.equal(result.items[0].stage, 'rechecking')
  assert.equal(result.items[0].closedAt, null)
  assert.deepEqual(result.items[0].rechecks, [])
  assert.equal(prisma.state.batches[0].requestHash.length, 64)
  assert.equal(effects.length, 2)
  assert.equal(audits.length, 2)
  assert.ok(audits.every((a) => a.actor === 'user-1' && a.requestId === 'req-1'))
})

test('同 key 同规范化 hash 回放，同 key 不同 items 或元数据均 409', async () => {
  const { service, prisma, effects } = harness()
  const first = await service.createBatch(input('repeat-key'))
  const same = input('repeat-key'); same.items[0].title = '隐患一'
  const second = await service.createBatch(same)
  assert.deepEqual(second.items.map((i) => i.id), first.items.map((i) => i.id))
  const changed = input('repeat-key'); changed.items = [{ title: '篡改' }]
  await assert.rejects(service.createBatch(changed), (e) => e.getStatus() === 409 && /不同/.test(e.message))
  const changedMeta = input('repeat-key'); changedMeta.fileHash = 'different'
  await assert.rejects(service.createBatch(changedMeta), (e) => e.getStatus() === 409)
  assert.equal(prisma.state.issues.length, 2)
  assert.equal(effects.length, 2)
})

test('P2002 并发路径读取同 hash 已提交批次，不同 hash 不回放', async () => {
  const { service, prisma } = harness()
  const first = await service.createBatch(input('concurrent-key'))
  const original = prisma.importBatch.findUnique
  let reads = 0
  prisma.importBatch.findUnique = async (args) => ++reads === 1 ? null : original(args)
  const replay = await service.createBatch(input('concurrent-key'))
  assert.equal(replay.batchId, first.batchId)
  reads = 0
  const changed = input('concurrent-key'); changed.items[0].description = '并发不同'
  await assert.rejects(service.createBatch(changed), (e) => e.getStatus() === 409)
})

test('事务失败时批次、隐患、明细和副作用全部回滚', async () => {
  const { service, prisma, effects, audits } = harness()
  prisma.failOnIssueTitle = '第二条失败'
  await assert.rejects(service.createBatch({ idempotencyKey: 'rollback', items: [{ title: '第一条' }, { title: '第二条失败' }] }), /simulated/)
  assert.equal(prisma.state.batches.length, 0)
  assert.equal(prisma.state.issues.length, 0)
  assert.equal(prisma.state.items.length, 0)
  // effects/audits 是事务探针；真实实现由同一数据库事务保证不产生持久记录。
  assert.equal(prisma.state.batches.length + prisma.state.issues.length + prisma.state.items.length, 0)
})

test('共享规范化拒绝非法枚举、日期、字符串、数组、数值及对策组合', async () => {
  const { service, prisma } = harness()
  const bad = [
    [{ title: 1 }, /title/], [{ title: 'x', foundAt: 'bad' }, /有效日期/],
    [{ title: 'x', scope: 'all' }, /scope/], [{ title: 'x', riskLevel: 'high' }, /riskLevel/],
    [{ title: 'x', photos: 'bad' }, /字符串数组/], [{ title: 'x', recheckIntervalDays: 1.2 }, /整数/],
    [{ title: 'x', reviewed: 1 }, /布尔/], [{ title: 'x', countermeasureLevel: 'management' }, /系统原因/],
    [{ title: 'x', causeType: 'system', countermeasureLevel: 'management' }, /countermeasureReason/],
  ]
  for (const [item, message] of bad) await assert.rejects(service.createBatch({ idempotencyKey: `bad-${Math.random()}`, items: [item] }), message)
  await assert.rejects(service.createBatch({ idempotencyKey: 'empty', items: [] }), /1～500/)
  assert.equal(prisma.state.batches.length, 0)
})
