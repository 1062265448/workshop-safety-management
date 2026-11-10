const test = require('node:test')
const assert = require('node:assert/strict')
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'commonjs',
    target: 'ES2021',
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    esModuleInterop: true,
  },
})
const { AgentService } = require('../src/modules/agent/agent.service.ts')
const { AgentTools } = require('../src/modules/agent/agent.tools.ts')
const { truncateTraceValue, validateEvidence } = require('../src/modules/agent/agent.evidence.ts')
const { LlmService } = require('../src/modules/knowledge/llm.service.ts')

function clone(value) {
  return value == null ? value : structuredClone(value)
}

function makeService(apiKey = '', options = {}) {
  const state = { runs: clone(options.runs ?? []), steps: [], fetchCalls: 0, countOverride: options.countOverride }
  const issue = {
    id: 'issue-real-1',
    title: '配电箱防护缺失',
    description: options.longDescription ?? '现场待复查',
    status: 'review',
    scope: 'managed',
    stage: 'fix',
    riskLevel: 'major',
    reviewed: false,
    foundAt: new Date('2026-11-01T00:00:00Z'),
    deadline: new Date('2026-11-02T00:00:00Z'),
    closedAt: null,
    recheckRequired: 1,
    rechecks: [],
  }
  const prisma = {
    setting: {
      async findMany() {
        return apiKey ? [
          { key: 'llm_api_key', value: apiKey },
          { key: 'llm_base_url', value: 'http://agent.test' },
          { key: 'llm_model', value: 'mock-model' },
        ] : []
      },
    },
    agentRun: {
      async create({ data }) {
        const run = {
          id: `run-${state.runs.length + 1}`,
          answer: '',
          error: null,
          completedAt: null,
          createdAt: new Date(),
          ...clone(data),
        }
        state.runs.push(run)
        return clone(run)
      },
      async count(args) {
        if (state.countOverride) return state.countOverride(args.where)
        const { createdBy, createdAt } = args.where
        return state.runs.filter((run) => {
          if (createdBy && run.createdBy !== createdBy) return false
          if (createdAt?.gt && !(run.createdAt > createdAt.gt)) return false
          if (createdAt?.gte && !(run.createdAt >= createdAt.gte)) return false
          return true
        }).length
      },
      async updateMany({ where, data }) {
        let count = 0
        for (const run of state.runs) {
          if (where.id && run.id !== where.id) continue
          if (where.createdBy && run.createdBy !== where.createdBy) continue
          if (where.status && run.status !== where.status) continue
          Object.assign(run, clone(data))
          count += 1
        }
        return { count }
      },
      async deleteMany({ where }) {
        const before = state.runs.length
        const removed = state.runs.filter((run) => run.createdAt < where.createdAt.lt).map((run) => run.id)
        state.runs = state.runs.filter((run) => !removed.includes(run.id))
        state.steps = state.steps.filter((step) => !removed.includes(step.runId))
        return { count: before - state.runs.length }
      },
      async findFirst({ where }) {
        const run = state.runs.find((item) => item.id === where.id && item.createdBy === where.createdBy)
        if (!run) return null
        return {
          ...clone(run),
          steps: state.steps.filter((step) => step.runId === run.id).sort((a, b) => a.seq - b.seq).map(clone),
        }
      },
      async findMany({ where, skip = 0, take = 10 }) {
        return state.runs
          .filter((run) => run.createdBy === where.createdBy)
          .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
          .slice(skip, skip + take)
          .map((run) => ({
            id: run.id,
            question: run.question,
            status: run.status,
            mode: run.mode,
            createdAt: run.createdAt,
            completedAt: run.completedAt,
            _count: { steps: state.steps.filter((step) => step.runId === run.id).length },
          }))
          .map(clone)
      },
    },
    agentStep: {
      async create({ data }) {
        const step = { id: `step-${state.steps.length + 1}`, createdAt: new Date(), ...clone(data) }
        state.steps.push(step)
        return { seq: step.seq }
      },
    },
    issue: {
      async count({ where }) {
        if (where.OR) return 1
        if (where.status === 'closed') return 2
        if (where.status?.not === 'closed') return 1
        return 5
      },
      async findMany() {
        return [clone(issue)]
      },
      async findFirst({ where }) {
        return where.id === issue.id ? { ...clone(issue), issueRegulations: [] } : null
      },
      async groupBy({ by }) {
        return by[0] === 'status'
          ? [{ status: 'closed', _count: { _all: 2 } }, { status: 'review', _count: { _all: 3 } }]
          : [{ riskLevel: 'major', _count: { _all: 5 } }]
      },
    },
    regulation: {
      async count() { return 0 },
      async findMany() { return [] },
    },
  }
  const tools = new AgentTools(prisma)
  const llm = new LlmService(prisma)
  return { service: new AgentService(prisma, tools, llm), tools, state }
}

function modelResponse(message, finishReason = 'stop') {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: finishReason }], usage: { total_tokens: 20 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function waitFor(check, message = '等待异步状态超时') {
  for (let index = 0; index < 100; index += 1) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(message)
}

async function waitTerminal(service, id, userId = 'user-1') {
  return waitFor(async () => {
    const run = await service.getRun(id, userId)
    return run.status === 'running' ? null : run
  })
}

test('能力接口只声明四个只读工具、固定预算和运行配额', async () => {
  const { service } = makeService()
  const capabilities = await service.capabilities()
  assert.equal(capabilities.llmConfigured, false)
  assert.deepEqual(capabilities.llm, {
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    protocol: 'OpenAI 兼容接口',
  })
  assert.equal(Object.hasOwn(capabilities.llm, 'apiKey'), false)
  assert.deepEqual(capabilities.tools, ['search_issues', 'get_issue', 'aggregate_safety_metrics', 'search_regulations'])
  assert.deepEqual(capabilities.toolCatalog.map((tool) => tool.label), ['检索隐患', '读取隐患详情', '聚合安全指标', '检索法规制度'])
  assert.deepEqual(capabilities.limits, { maxSteps: 6, maxModelCalls: 3, timeoutMs: 180000 })
  assert.equal(capabilities.quotas.userPerMinute, 10)
  assert.equal(capabilities.quotas.dailyRuns, 200)
})

test('未知工具和非法结果上限直接被拒绝', async () => {
  const { tools } = makeService()
  await assert.rejects(tools.execute('delete_issue', {}), /不允许调用工具/)
  await assert.rejects(tools.execute('search_issues', { limit: 21 }), /1～20/)
  await assert.rejects(tools.execute('aggregate_safety_metrics', { scope: 'other' }), /scope/)
})

test('指标工具使用数据库聚合并返回明确口径', async () => {
  const { tools } = makeService()
  const result = await tools.execute('aggregate_safety_metrics', { scope: 'managed' })
  assert.equal(result.total, 5)
  assert.equal(result.closed, 2)
  assert.equal(result.open, 3)
  assert.equal(result.overdue, 1)
  assert.equal(result.closureRate, 0.4)
  assert.equal(result.metricVersion, 'safety-v1')
  assert.deepEqual(result.byStatus, { pending: 0, fixing: 0, closed: 2, review: 3 })
})

test('POST 创建立即返回 running，规则降级随后异步完成且数字来自工具', async () => {
  const { service, state } = makeService()
  const created = await service.run('统计本月成品车间闭环情况', 'user-1')
  assert.equal(created.status, 'running')
  assert.deepEqual(created.steps, [])
  const run = await waitTerminal(service, created.id)
  assert.equal(run.status, 'succeeded', run.error ?? run.answer)
  assert.equal(run.mode, 'fallback')
  assert.match(run.answer, /共 5 条隐患/)
  assert.match(run.answer, /闭环率 40\.0%/)
  assert.equal(run.steps.length, 2)
  assert.equal(run.steps[0].kind, 'tool')
  assert.equal(run.steps[0].name, 'aggregate_safety_metrics')
  assert.equal(run.steps[1].kind, 'validation')
  assert.equal(state.runs[0].completedAt !== null, true)
})

test('模型未调用工具时证据验收失败并转人工', async () => {
  const { service } = makeService('test-key')
  const originalFetch = global.fetch
  global.fetch = async () => modelResponse({ content: '没有依据的回答' })
  try {
    const created = await service.run('随便回答', 'user-1')
    const run = await waitTerminal(service, created.id)
    assert.equal(run.status, 'waiting_human')
    assert.doesNotMatch(run.answer, /没有依据的回答/)
    assert.equal(run.steps.at(-1).name, 'evidence_required')
  } finally {
    global.fetch = originalFetch
  }
})

test('模型工具调用形成完整轨迹，正确统计数字通过确定性验收', async () => {
  const { service, state } = makeService('test-key')
  const originalFetch = global.fetch
  global.fetch = async (_url, init) => {
    state.fetchCalls += 1
    const body = JSON.parse(init.body)
    if (state.fetchCalls === 1) {
      assert.equal(body.tools.length, 4)
      return modelResponse({
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'aggregate_safety_metrics', arguments: '{"scope":"managed"}' } }],
      }, 'tool_calls')
    }
    assert.equal(body.messages.at(-1).role, 'tool')
    assert.match(body.messages.at(-1).content, /"total":5/)
    return modelResponse({ content: '数据库聚合显示共 5 条隐患，闭环率为 40%。' })
  }
  try {
    const created = await service.run('统计隐患', 'user-1')
    const run = await waitTerminal(service, created.id)
    assert.equal(run.status, 'succeeded')
    assert.equal(run.mode, 'agent')
    assert.deepEqual(run.steps.map((step) => step.kind), ['model', 'tool', 'model', 'validation'])
    assert.equal(run.steps.at(-1).name, 'evidence_check')
    assert.equal(run.steps.at(-1).status, 'succeeded')
    assert.equal(state.fetchCalls, 2)
  } finally {
    global.fetch = originalFetch
  }
})

test('闭环率的小数和百分数表达都必须匹配聚合字段', () => {
  const steps = [{ seq: 1, name: 'aggregate_safety_metrics', status: 'succeeded', output: { total: 5, closed: 2, open: 3, overdue: 1, closureRate: 0.4 } }]
  assert.equal(validateEvidence('共 5 条隐患，闭环率为 0.4。', steps).ok, true)
  assert.equal(validateEvidence('共 5 条隐患，闭环率为 40%。', steps).ok, true)
  assert.equal(validateEvidence('共 5 条隐患，闭环率为 0.5。', steps).ok, false)
  assert.equal(validateEvidence('共 5 条隐患，闭环率为 50%。', steps).ok, false)
})

test('日期、列表序号和独立问题数不会干扰聚合指标验收', () => {
  const steps = [{
    seq: 1,
    name: 'aggregate_safety_metrics',
    status: 'succeeded',
    output: {
      total: 6,
      closed: 0,
      open: 6,
      overdue: 0,
      closureRate: 0,
      period: { start: '2026-11-01T00:00:00.000Z', end: '2026-11-09T00:00:00.000Z' },
    },
  }]
  const answer = [
    '统计周期：2026-11-01 至 2026-11-09。',
    '| 本月新发现 | 6 条 |',
    '| 已闭环 | 0 条 |',
    '| 未闭环 | 6 条 |',
    '| 超期 | 0 条 |',
    '| 闭环率 | 0% |',
    '本月共 4 个独立问题，对应 6 条记录：',
    '1. 第一项；2. 第二项。',
  ].join('\n')
  assert.equal(validateEvidence(answer, steps).ok, true)
})

test('表格中的错误聚合总数仍会被拒绝', () => {
  const steps = [{ seq: 1, name: 'aggregate_safety_metrics', status: 'succeeded', output: { total: 6, closed: 0, open: 6, overdue: 0, closureRate: 0 } }]
  const result = validateEvidence('| 本月隐患总数 | 7 条 |\n| 已闭环 | 0 条 |', steps)
  assert.equal(result.ok, false)
  assert.match(result.reason, /total 数值 7/)
})

test('到期应闭环数和按期闭环数不会被误判为已闭环数', () => {
  const steps = [
    { seq: 1, name: 'aggregate_safety_metrics', status: 'succeeded', output: { total: 6, closed: 0, open: 6, overdue: 0, closureRate: 0, dueTotal: 9, dueClosedOnTime: 0 } },
    { seq: 2, name: 'aggregate_safety_metrics', status: 'succeeded', output: { total: 82, closed: 0, open: 82, overdue: 0, closureRate: 0, dueTotal: 0, dueClosedOnTime: 0 } },
  ]
  const answer = '| 对比项 | 成品车间 | 其他车间 |\n| 新增隐患总数 | 6 | 82 |\n| 已闭环 | 0 | 0 |\n| 未闭环 | 6 | 82 |\n| 到期应闭环数 | 9 | 0 |\n| 按期闭环数 | 0 | 0 |'
  assert.equal(validateEvidence(answer, steps, '比较成品车间和其他车间本月隐患闭环情况').ok, true)
  const wrongClosed = validateEvidence(answer.replace('| 已闭环 | 0 | 0 |', '| 已闭环 | 9 | 0 |'), steps)
  assert.equal(wrongClosed.ok, false)
  assert.match(wrongClosed.reason, /closed 数值 9/)
})

test('检索总数和聚合总数按各自证据来源验收', () => {
  const steps = [
    { seq: 1, name: 'aggregate_safety_metrics', status: 'succeeded', output: { total: 6, closed: 0, open: 6, overdue: 0, closureRate: 0 } },
    { seq: 2, name: 'search_issues', status: 'succeeded', output: { total: 23, items: [] } },
  ]
  const answer = '本月新增隐患 6 条，历史检索状态为 closed 的记录共 23 条。'
  assert.equal(validateEvidence(answer, steps).ok, true)
  const wrongCount = validateEvidence('本月新增隐患 6 条，历史记录共 24 条。', steps)
  assert.equal(wrongCount.ok, false)
  assert.match(wrongCount.reason, /成功工具返回的总数/)
  assert.equal(validateEvidence('本月新增隐患 23 条，历史记录共 23 条。', steps).ok, false)
})

test('检索回答中的统计范围说明不会被误判为聚合统计', () => {
  const steps = [{ seq: 1, name: 'search_issues', status: 'succeeded', output: { total: 0, returned: 0, items: [] } }]
  const question = '查找待复查的重大隐患'
  const scopeAnswer = '未检索到匹配隐患。统计范围：成品车间和其他车间；两个范围的 total 均为 0 条。'
  const summaryAnswer = '按默认范围“成品车间”查询，隐患共 0 条。说明：本次仅统计成品车间。'
  assert.equal(validateEvidence(scopeAnswer, steps, question).ok, true)
  assert.equal(validateEvidence(summaryAnswer, steps, question).ok, true)
})

test('统计问题不能使用检索结果代替聚合工具证据', () => {
  const steps = [{ seq: 1, name: 'search_issues', status: 'succeeded', output: { total: 0, returned: 0, items: [] } }]
  const result = validateEvidence('本次仅统计成品车间，共 0 条隐患。', steps, '统计本月成品车间隐患')
  assert.equal(result.ok, false)
  assert.match(result.reason, /缺少 aggregate_safety_metrics 成功结果/)
})

test('工具预算为最终回答预留一步，无结果检索可以正常完成', async () => {
  const { service, state } = makeService('test-key')
  const originalFetch = global.fetch
  global.fetch = async (_url, init) => {
    state.fetchCalls += 1
    const body = JSON.parse(init.body)
    if (state.fetchCalls === 1) {
      return modelResponse({
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_regulations', arguments: '{"query":"电气安全"}' } }],
      }, 'tool_calls')
    }
    if (state.fetchCalls === 2) {
      return modelResponse({
        content: null,
        tool_calls: [
          { id: 'call-2', type: 'function', function: { name: 'search_regulations', arguments: '{"query":"电气"}' } },
          { id: 'call-3', type: 'function', function: { name: 'search_regulations', arguments: '{"query":"临时用电"}' } },
          { id: 'call-4', type: 'function', function: { name: 'search_regulations', arguments: '{"query":"配电箱 漏电保护"}' } },
        ],
      }, 'tool_calls')
    }
    assert.equal(state.fetchCalls, 3)
    assert.equal(body.messages.at(-1).role, 'user')
    assert.match(body.messages.at(-1).content, /不要再调用任何工具/)
    return modelResponse({ content: '已按“电气安全”“电气”“临时用电”检索，均未找到匹配法规制度。' })
  }
  try {
    const created = await service.run('检索电气安全相关法规', 'user-1')
    const run = await waitTerminal(service, created.id)
    assert.equal(run.status, 'succeeded')
    assert.deepEqual(run.steps.map((step) => step.kind), ['model', 'tool', 'model', 'tool', 'tool', 'model', 'validation'])
    assert.deepEqual(run.steps.filter((step) => step.kind === 'tool').map((step) => step.input.query), ['电气安全', '电气', '临时用电'])
    assert.equal(run.steps.at(-1).name, 'evidence_check')
    assert.equal(run.steps.at(-1).status, 'succeeded')
    assert.equal(state.fetchCalls, 3)
  } finally {
    global.fetch = originalFetch
  }
})

test('统计回答中的错误数字被拒绝，即使模型调用过聚合工具', async () => {
  const { service, state } = makeService('test-key')
  const originalFetch = global.fetch
  global.fetch = async () => {
    state.fetchCalls += 1
    if (state.fetchCalls === 1) {
      return modelResponse({
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'aggregate_safety_metrics', arguments: '{"scope":"managed"}' } }],
      }, 'tool_calls')
    }
    return modelResponse({ content: '共 6 条隐患，已闭环 5 条，闭环率为 50%。' })
  }
  try {
    const created = await service.run('统计隐患', 'user-1')
    const run = await waitTerminal(service, created.id)
    assert.equal(run.status, 'waiting_human')
    assert.doesNotMatch(run.answer, /共 6 条/)
    assert.equal(run.steps.at(-1).name, 'evidence_check')
    assert.equal(run.steps.at(-1).status, 'failed')
    assert.match(run.steps.at(-1).output.reason, /不一致/)
  } finally {
    global.fetch = originalFetch
  }
})

test('引用成功工具结果之外的隐患 ID 被拒绝', async () => {
  const { service, state } = makeService('test-key')
  const originalFetch = global.fetch
  global.fetch = async () => {
    state.fetchCalls += 1
    if (state.fetchCalls === 1) {
      return modelResponse({
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_issues', arguments: '{"query":"配电箱"}' } }],
      }, 'tool_calls')
    }
    return modelResponse({ content: '隐患 ID：issue-fake-9 需要复查。' })
  }
  try {
    const created = await service.run('查找配电箱隐患', 'user-1')
    const run = await waitTerminal(service, created.id)
    assert.equal(run.status, 'waiting_human')
    assert.doesNotMatch(run.answer, /issue-fake-9/)
    assert.match(run.steps.at(-1).output.reason, /不在成功工具结果中/)
  } finally {
    global.fetch = originalFetch
  }
})

test('模型请求中止时显示中文超时原因，不暴露英文异常', async () => {
  const { service } = makeService('test-key')
  const originalFetch = global.fetch
  global.fetch = async () => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }) }
  try {
    await assert.rejects(
      service.callModel({ apiKey: 'test-key', baseUrl: 'http://agent.test', model: 'mock-model' }, [], 1000, new AbortController()),
      (error) => /模型响应超过 1 秒/.test(error.message) && !/aborted/i.test(error.message),
    )
  } finally {
    global.fetch = originalFetch
  }
})

test('创建人可取消 running，执行者完成后不能覆盖 cancelled', async () => {
  const { service, state } = makeService('test-key')
  const originalFetch = global.fetch
  global.fetch = async (_url, init) => {
    state.fetchCalls += 1
    return new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (init.signal.aborted) abort()
      else init.signal.addEventListener('abort', abort, { once: true })
    })
  }
  try {
    const created = await service.run('统计隐患', 'user-1')
    await waitFor(() => state.fetchCalls === 1, '模型未开始调用')
    await assert.rejects(service.cancel(created.id, 'user-2'), /不存在/)
    const cancelled = await service.cancel(created.id, 'user-1')
    assert.equal(cancelled.status, 'cancelled')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const finalRun = await service.getRun(created.id, 'user-1')
    assert.equal(finalRun.status, 'cancelled')
    assert.equal(finalRun.steps.at(-1).name, 'run_cancelled')
    await assert.rejects(service.cancel(created.id, 'user-1'), /只能取消/)
  } finally {
    global.fetch = originalFetch
  }
})

test('递归截断保留 ID 字段、数字及长文本中的可验证标记', async () => {
  const longDescription = `${'很长的现场描述。'.repeat(500)} 结尾数字 98765，隐患 ID：issue-real-1`
  const { service } = makeService('', { longDescription })
  const value = truncateTraceValue({ id: 'issue-real-1', count: 5, description: longDescription, items: Array.from({ length: 30 }, (_, index) => index) })
  assert.equal(value.id, 'issue-real-1')
  assert.equal(value.count, 5)
  assert.equal(value.items.length, 21)
  assert.equal(value.description.length <= 2000, true)
  assert.match(value.description, /98765/)

  const created = await service.run('查找配电箱隐患', 'user-1')
  const run = await waitTerminal(service, created.id)
  const output = run.steps[0].output
  assert.equal(output.items[0].id, 'issue-real-1')
  assert.equal(output.items[0].description.length <= 2000, true)
  assert.match(output.items[0].description, /98765/)
})

test('用户速率、全局速率和每日运行预算超限均返回 429', async (t) => {
  await t.test('用户速率', async () => {
    const { service, state } = makeService('', { countOverride: (where) => where.createdBy ? 10 : 0 })
    await assert.rejects(service.run('统计隐患', 'user-1'), (error) => error.getStatus() === 429 && /当前用户/.test(error.message))
    assert.equal(state.runs.length, 0)
  })
  await t.test('全局速率', async () => {
    const { service } = makeService('', { countOverride: (where) => !where.createdBy && where.createdAt.gt ? 30 : 0 })
    await assert.rejects(service.run('统计隐患', 'user-1'), (error) => error.getStatus() === 429 && /全局/.test(error.message))
  })
  await t.test('每日预算', async () => {
    const { service } = makeService('', { countOverride: (where) => where.createdAt.gte ? 200 : 0 })
    await assert.rejects(service.run('统计隐患', 'user-1'), (error) => error.getStatus() === 429 && /今日/.test(error.message))
  })
})

test('启动时清理 90 天前记录并终结遗留 running', async () => {
  const now = Date.now()
  const { service, state } = makeService('', {
    runs: [
      { id: 'old', question: '旧任务', status: 'succeeded', mode: 'fallback', answer: '', error: null, createdBy: 'user-1', createdAt: new Date(now - 91 * 86400000), completedAt: new Date(now - 91 * 86400000) },
      { id: 'legacy', question: '遗留任务', status: 'running', mode: 'agent', answer: '', error: null, createdBy: 'user-1', createdAt: new Date(now - 1000), completedAt: null },
    ],
  })
  await service.onModuleInit()
  assert.equal(state.runs.some((run) => run.id === 'old'), false)
  assert.equal(state.runs.find((run) => run.id === 'legacy').status, 'failed')
  assert.notEqual(state.runs.find((run) => run.id === 'legacy').completedAt, null)
})

test('运行轨迹只能由创建人读取', async () => {
  const { service } = makeService()
  const created = await service.run('统计隐患', 'user-1')
  const run = await waitTerminal(service, created.id)
  const own = await service.getRun(run.id, 'user-1')
  assert.equal(own.id, run.id)
  await assert.rejects(service.getRun(run.id, 'user-2'), /不存在/)
})

test('历史调用记录仅返回本人数据并支持分页和步骤计数', async () => {
  const { service } = makeService()
  const first = await service.run('统计本月成品车间闭环情况', 'user-1')
  const second = await service.run('检索电气安全相关法规', 'user-1')
  const other = await service.run('统计隐患', 'user-2')
  await Promise.all([
    waitTerminal(service, first.id),
    waitTerminal(service, second.id),
    waitTerminal(service, other.id, 'user-2'),
  ])

  const page1 = await service.listRuns('user-1', 1, 1)
  assert.equal(page1.total, 2)
  assert.equal(page1.totalPages, 2)
  assert.equal(page1.items.length, 1)
  assert.equal(page1.items[0].stepCount, 2)
  assert.equal(Object.hasOwn(page1.items[0], 'steps'), false)
  const page2 = await service.listRuns('user-1', 2, 1)
  assert.equal(page2.items.length, 1)
  assert.notEqual(page2.items[0].id, page1.items[0].id)
  const otherUser = await service.listRuns('user-2', 1, 10)
  assert.equal(otherUser.total, 1)
  assert.equal(otherUser.items[0].id, other.id)
  await assert.rejects(service.listRuns('user-1', 0, 10), /page/)
  await assert.rejects(service.listRuns('user-1', 1, 51), /pageSize/)
})
