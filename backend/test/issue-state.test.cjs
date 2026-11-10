const test = require('node:test')
const assert = require('node:assert/strict')
const { IssuesService } = require('../dist/modules/issues/issues.service.js')

function baseIssue(overrides = {}) {
  return {
    id: 'issue-1', title: '测试隐患', description: '', locationId: null, categoryId: null,
    tagIds: [], riskLevel: 'general', status: 'pending', scope: 'managed', source: 'manual',
    sourceFile: null, reporter: '', assignee: null, foundAt: new Date('2026-01-01T00:00:00Z'),
    deadline: null, closedAt: null, fixNote: null, photos: [], recheckIntervalDays: 7,
    recheckRequired: 3, rechecks: [], team: null, gridOperator: null, gridOwner: null,
    systemOwner: null, systemCause: null, causeType: null, countermeasureLevel: null,
    countermeasureReason: null, stage: 'rechecking', institutionNote: null,
    linkedKnowledgeDocId: null, deletedAt: null, reviewed: true, isGood: false,
    requestKey: null, requestHash: null, issueRegulations: [{ regulation: { id: 'regulation-1' } }],
    ...overrides,
  }
}
const clone = (value) => value == null ? value : structuredClone(value)
function matches(issue, where) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'rechecks') return issue.rechecks.length === expected.equals.length && issue.rechecks.every((v, i) => v === expected.equals[i])
    if (key === 'deletedAt' && expected === null) return issue.deletedAt === null
    return issue[key] === expected
  })
}
function makeService(initial = baseIssue()) {
  const state = { issue: clone(initial), updateManyCalls: 0, updateCalls: 0, audits: [], effects: [], recheckRecords: [] }
  const prisma = {
    issue: {
      async findUnique({ where }) {
        if (where.requestKey && state.issue?.requestKey !== where.requestKey) return null
        if (where.id && state.issue?.id !== where.id) return null
        return clone(state.issue)
      },
      async create({ data }) {
        if (data.requestKey && state.issue?.requestKey === data.requestKey) {
          const error = new Error('duplicate'); error.code = 'P2002'; throw error
        }
        state.issue = { ...baseIssue(), ...clone(data), id: 'created', issueRegulations: [] }
        return clone(state.issue)
      },
      async update({ data }) {
        state.updateCalls++
        if (!state.issue) throw new Error('not found')
        state.issue = { ...state.issue, ...clone(data) }
        return clone(state.issue)
      },
      async updateMany({ where, data }) {
        state.updateManyCalls++
        if (!state.issue || !matches(state.issue, where)) return { count: 0 }
        state.issue = { ...state.issue, ...clone(data) }
        return { count: 1 }
      },
    },
    recheckRecord: { async create({ data }) { state.recheckRecords.push(clone(data)); return clone(data) } },
    reminder: { async deleteMany() { return { count: 0 } } },
    $transaction: async (run) => run(prisma),
  }
  const outbox = {
    kick() {},
    async enqueue(_tx, type, key, payload) { state.effects.push({ type, key, payload }) },
    async enqueueIssueEffects(_tx, issue, key) { state.effects.push({ type: 'issue.effects', key, payload: { id: issue.id } }) },
  }
  const audit = { async record(_tx, input) { state.audits.push(clone(input)) } }
  return { service: new IssuesService(prisma, outbox, audit), state, prisma }
}
async function rejectsHttp(promise, status, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(typeof error.getStatus, 'function')
    assert.equal(error.getStatus(), status)
    if (message) assert.match(error.message, message)
    return true
  })
}
const createInput = (extra = {}) => ({ idempotencyKey: 'manual-1', title: '导入隐患', ...extra })

test('创建强制初始状态，规范化字段并同事务写审计和 Outbox', async () => {
  const { service, state } = makeService()
  const issue = await service.create(createInput({
    title: '  导入隐患  ', riskLevel: 'major', status: 'closed', stage: 'done',
    closedAt: '2026-01-01T00:00:00.000Z', rechecks: ['x'], reviewed: false,
  }), { actor: 'user-1', requestId: 'req-1' })
  assert.equal(issue.title, '导入隐患')
  assert.equal(issue.riskLevel, 'major')
  assert.equal(issue.status, 'pending')
  assert.equal(issue.stage, 'rechecking')
  assert.equal(issue.closedAt, null)
  assert.deepEqual(issue.rechecks, [])
  assert.equal(issue.reviewed, false)
  assert.equal(state.audits[0].actor, 'user-1')
  assert.equal(state.audits[0].requestId, 'req-1')
  assert.equal(state.effects.length, 1)
  assert.equal(state.issue.requestHash.length, 64)
})

test('手工创建同 key 同规范化请求回放，不同内容 409，缺 key 400', async () => {
  const { service, state } = makeService()
  const first = await service.create(createInput({ title: '  相同标题  ' }))
  const replay = await service.create(createInput({ title: '相同标题' }))
  assert.equal(replay.id, first.id)
  assert.equal(state.audits.length, 1)
  await rejectsHttp(service.create(createInput({ title: '不同内容' })), 409, /不同/)
  await rejectsHttp(service.create({ title: '没有键' }), 400, /idempotencyKey/)
})

test('创建 P2002 并发路径按 requestKey 回放且校验 hash', async () => {
  const existing = makeService()
  const first = await existing.service.create(createInput({ title: '并发标题' }))
  const racing = makeService(null)
  racing.state.issue = clone(existing.state.issue)
  let reads = 0
  const original = racing.prisma.issue.findUnique
  racing.prisma.issue.findUnique = async (args) => ++reads === 1 ? null : original(args)
  const replay = await racing.service.create(createInput({ title: '并发标题' }))
  assert.equal(replay.id, first.id)
  await rejectsHttp(racing.service.create(createInput({ title: '并发不同' })), 409)
})

test('创建和导入共用规范化：标题、日期、枚举、数组、数值、布尔均返回 400', async () => {
  const { service } = makeService()
  const bad = [
    [{ title: 1 }, /title/], [{ foundAt: 'bad' }, /foundAt/], [{ scope: 'all' }, /scope/],
    [{ riskLevel: 'high' }, /riskLevel/], [{ source: 'unknown' }, /source/],
    [{ photos: 'not-array' }, /photos/], [{ tagIds: [1] }, /tagIds/],
    [{ recheckIntervalDays: 0 }, /recheckIntervalDays/], [{ reviewed: 'yes' }, /reviewed/],
  ]
  for (const [patch, message] of bad) await rejectsHttp(service.create(createInput(patch)), 400, message)
})

test('通用 PATCH 六个状态机字段出现即 400，不能静默忽略', async () => {
  for (const field of ['scope', 'status', 'stage', 'closedAt', 'rechecks', 'reviewed']) {
    const { service, state } = makeService(baseIssue({ status: 'review', reviewed: false }))
    await rejectsHttp(service.update('issue-1', { title: 'x', [field]: null }), 400, /禁止修改/)
    assert.equal(state.updateCalls, 0)
    assert.equal(state.issue.title, '测试隐患')
  }
})

test('闭环后普通 PATCH 禁止改证据，专用更正要求 reason 并写审计', async () => {
  const closed = baseIssue({ status: 'closed', stage: 'done', fixNote: '原始', closedAt: new Date() })
  const { service, state } = makeService(closed)
  await rejectsHttp(service.update('issue-1', { fixNote: '篡改' }), 400, /证据更正/)
  await rejectsHttp(service.update('issue-1', { photos: [] }), 400, /证据更正/)
  await rejectsHttp(service.correctEvidence('issue-1', { fixNote: '更正' }), 400, /reason/)
  const updated = await service.correctEvidence('issue-1', { fixNote: '更正', reason: '补录说明' }, { actor: 'admin-1' })
  assert.equal(updated.fixNote, '更正')
  assert.equal(state.audits.at(-1).action, 'issue.evidence.correct')
  assert.equal(state.audits.at(-1).detail.reason, '补录说明')
  assert.equal(state.audits.at(-1).actor, 'admin-1')
})

test('条件更新 count=0 只有精确目标已满足才幂等，否则 409', async () => {
  const { service, prisma, state } = makeService(baseIssue({ status: 'fixing' }))
  prisma.issue.updateMany = async () => ({ count: 0 })
  await rejectsHttp(service.updateStatus('issue-1', 'review'), 409, /目标未达成/)
  state.issue.status = 'review'
  assert.equal((await service.updateStatus('issue-1', 'review')).status, 'review')
})

test('状态按序推进并写 actor/from/to 审计', async () => {
  const { service, state } = makeService()
  await service.updateStatus('issue-1', 'fixing', { actor: 'user-9', requestId: 'r9' })
  await service.updateStatus('issue-1', 'review', { actor: 'user-9', requestId: 'r9' })
  assert.equal(state.audits.length, 2)
  assert.deepEqual(state.audits.map((a) => [a.from, a.to]), [['pending', 'fixing'], ['fixing', 'review']])
  assert.ok(state.audits.every((a) => a.actor === 'user-9'))
  await rejectsHttp(service.updateStatus('issue-1', 'pending'), 400, /不能回退/)
})

test('闭环重复同内容幂等，不同 fixNote/photos/closedAt 均 409', async () => {
  const closedAt = new Date('2026-02-03T04:05:06.000Z')
  const initial = baseIssue({ status: 'review', stage: 'done', rechecks: ['1', '2', '3'] })
  const { service, state } = makeService(initial)
  const body = { fixNote: '  已完成整改  ', photos: ['/uploads/after.jpg'], closedAt: closedAt.toISOString() }
  const first = await service.close('issue-1', body, { actor: 'closer' })
  assert.equal(first.fixNote, '已完成整改')
  const writes = state.updateManyCalls
  assert.equal((await service.close('issue-1', { ...body, fixNote: '已完成整改' })).id, first.id)
  assert.equal(state.updateManyCalls, writes)
  await rejectsHttp(service.close('issue-1', { ...body, fixNote: '不同' }), 409)
  await rejectsHttp(service.close('issue-1', { ...body, photos: [] }), 409)
  await rejectsHttp(service.close('issue-1', { ...body, closedAt: '2027-01-01T00:00:00Z' }), 409)
  assert.equal(state.audits.filter((a) => a.action === 'issue.close').length, 1)
})

test('闭环校验 scope、门槛与输入类型', async () => {
  const valid = { status: 'review', stage: 'done', rechecks: ['1', '2', '3'], fixNote: '已整改' }
  for (const [patch, message] of [
    [{ ...valid, status: 'pending' }, /待复查/], [{ ...valid, reviewed: false }, /人工复核/],
    [{ ...valid, rechecks: ['1'] }, /复查次数不足/], [{ ...valid, stage: 'executing' }, /阶段尚未完成/],
    [{ ...valid, fixNote: null }, /整改记录/], [{ ...valid, scope: 'invalid' }, /scope 非法/],
  ]) await rejectsHttp(makeService(baseIssue(patch)).service.close('issue-1', {}), 400, message)
  assert.equal((await makeService(baseIssue({ scope: 'reference' })).service.close('issue-1', {})).status, 'closed')
  await rejectsHttp(makeService(baseIssue(valid)).service.close('issue-1', { closedAt: 'bad' }), 400, /closedAt/)
  await rejectsHttp(makeService(baseIssue(valid)).service.close('issue-1', { photos: [1] }), 400, /photos/)
})

test('复查保存 pass/fail、actor、note、photos、时间；失败必须 note', async () => {
  const { service, state } = makeService(baseIssue({ status: 'review' }))
  await rejectsHttp(service.recheck('issue-1', { failed: true }), 400, /note/)
  await service.recheck('issue-1', { failed: true, note: '问题复发', photos: ['/uploads/fail.jpg'] }, { actor: 'checker' })
  assert.equal(state.recheckRecords[0].result, 'fail')
  assert.equal(state.recheckRecords[0].pass, false)
  assert.equal(state.recheckRecords[0].fail, true)
  assert.equal(state.recheckRecords[0].actor, 'checker')
  assert.equal(state.recheckRecords[0].note, '问题复发')
  assert.equal(state.issue.recheckRequired, 4)
  await service.recheck('issue-1', { note: '首次合格' }, { actor: 'checker' })
  assert.equal(state.recheckRecords.at(-1).result, 'pass')
  assert.equal(state.recheckRecords.at(-1).checkedAt instanceof Date, true)
  assert.equal(state.audits.filter((a) => a.action === 'issue.recheck').length, 2)
})

test('并发复查目标已达成可回放，被其他不同操作改变则 409', async () => {
  const concurrent = makeService(baseIssue({ status: 'review' }))
  const [first, second] = await Promise.all([concurrent.service.recheck('issue-1'), concurrent.service.recheck('issue-1')])
  assert.equal(first.rechecks.length, 1)
  assert.equal(second.rechecks.length, 1)
  const conflict = makeService(baseIssue({ status: 'review', rechecks: ['other-1', 'other-2'] }))
  conflict.prisma.issue.updateMany = async () => ({ count: 0 })
  await rejectsHttp(conflict.service.recheck('issue-1'), 409)
})

test('制度沉淀至少 note 或 linkedKnowledgeDocId，阶段推进写审计', async () => {
  const issue = baseIssue({ status: 'review', stage: 'institutionalizing', rechecks: ['1', '2', '3'] })
  const { service, state } = makeService(issue)
  await rejectsHttp(service.advanceStage('issue-1', {}), 400, /至少/)
  const updated = await service.advanceStage('issue-1', { linkedKnowledgeDocId: 'doc-1' }, { actor: 'user-1' })
  assert.equal(updated.stage, 'educating')
  assert.equal(updated.linkedKnowledgeDocId, 'doc-1')
  assert.equal(state.audits.at(-1).action, 'issue.stage')
})

test('回收站记录除 restore/hardRemove 外不能执行工作流', async () => {
  const deleted = baseIssue({ status: 'review', deletedAt: new Date() })
  const { service } = makeService(deleted)
  for (const call of [
    () => service.update('issue-1', { title: 'x' }), () => service.updateStatus('issue-1', 'review'),
    () => service.close('issue-1', {}), () => service.recheck('issue-1'),
    () => service.advanceStage('issue-1', {}), () => service.markReviewed('issue-1'),
    () => service.correctEvidence('issue-1', { fixNote: 'x', reason: 'x' }),
  ]) await rejectsHttp(call(), 409, /回收站/)
})

test('不存在记录仍返回 404', async () => {
  await rejectsHttp(makeService(null).service.update('missing', { title: 'x' }), 404)
})
