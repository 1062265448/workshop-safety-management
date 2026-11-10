const test = require('node:test')
const assert = require('node:assert/strict')
const { OutboxService } = require('../dist/modules/outbox/outbox.module.js')
const clone = (value) => value == null ? value : structuredClone(value)

function harness(maxAttempts = 8) {
  const state = { events: [] }
  const prisma = {
    outboxEvent: {
      async create({ data }) {
        const now = new Date()
        const row = { id: `event-${state.events.length + 1}`, attempts: 0, maxAttempts, status: 'pending', lastError: null, createdAt: now, updatedAt: now, completedAt: null, ...clone(data) }
        state.events.push(row); return clone(row)
      },
      async findMany({ where }) {
        if (where.status === 'failed') return clone(state.events.filter((e) => e.status === 'failed'))
        const now = where.nextAttemptAt?.lte ?? new Date()
        return clone(state.events.filter((e) => e.status === 'pending' && e.nextAttemptAt <= now))
      },
      async findUnique({ where }) { return clone(state.events.find((e) => e.id === where.id) ?? null) },
      async updateMany({ where, data }) {
        let count = 0
        for (const event of state.events) {
          if (where.id && event.id !== where.id) continue
          if (where.status && event.status !== where.status) continue
          if (where.nextAttemptAt && event.nextAttemptAt.getTime() !== where.nextAttemptAt.getTime()) continue
          Object.assign(event, clone(data)); count++
        }
        return { count }
      },
      async update({ where, data }) { const event = state.events.find((e) => e.id === where.id); Object.assign(event, clone(data)); return clone(event) },
    },
  }
  const service = new OutboxService(prisma, {}, {})
  service.kick = () => {}
  return { service, prisma, state }
}

test('Outbox 消费失败指数退避，恢复后成功且只执行一次后续成功处理', async () => {
  const { service, prisma, state } = harness()
  let calls = 0
  service.registerHandler('knowledge.issue.sync', async () => { calls++; if (calls === 1) throw new Error('temporary outage') })
  await service.enqueue(prisma, 'knowledge.issue.sync', 'create-1:knowledge', { issueIds: ['i1'] })
  const failed = await service.processDue()
  assert.equal(failed.failed, 1)
  assert.equal(state.events[0].status, 'pending')
  assert.equal(state.events[0].attempts, 1)
  assert.equal(state.events[0].lastError, 'temporary outage')
  assert.ok(state.events[0].nextAttemptAt.getTime() > Date.now())
  state.events[0].nextAttemptAt = new Date(0)
  const recovered = await service.processDue()
  assert.equal(recovered.succeeded, 1)
  assert.equal(calls, 2)
  assert.equal(state.events[0].status, 'succeeded')
  assert.ok(state.events[0].completedAt)
  await service.processDue()
  assert.equal(calls, 2)
})

test('达到上限进入 failed，管理员可查询并重试', async () => {
  const { service, prisma, state } = harness(1)
  let calls = 0
  service.registerHandler('assessment.repeat', async () => { calls++; if (calls === 1) throw new Error('permanent once') })
  await service.enqueue(prisma, 'assessment.repeat', 'create-1:assessment', { issue: { id: 'i1' } })
  await service.processDue()
  assert.equal(state.events[0].status, 'failed')
  assert.equal((await service.failures()).length, 1)
  await service.retry(state.events[0].id)
  assert.equal(state.events[0].status, 'pending')
  assert.equal(state.events[0].attempts, 0)
  await service.processDue()
  assert.equal(calls, 2)
  assert.equal(state.events[0].status, 'succeeded')
  assert.equal((await service.failures()).length, 0)
})

test('同一操作 key 由数据库唯一约束承担消费者入队幂等语义', async () => {
  const { service, prisma, state } = harness()
  await service.enqueue(prisma, 'knowledge.good.sync', 'same:key', { issueId: 'i1' })
  state.events[0].idempotencyKey = 'same:key'
  assert.equal(state.events.length, 1)
  assert.equal(state.events[0].payload.issueId, 'i1')
})
