import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  History,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
} from 'lucide-react'
import { api } from '@/lib/store'
import { getCurrentUser } from '@/lib/auth'

interface AgentCapabilities {
  llmConfigured: boolean
  llm?: {
    model: string
    baseUrl: string
    endpoint: string
    protocol: string
  }
  tools: string[]
  toolCatalog?: { id: string; label: string; description: string }[]
  limits: {
    maxSteps: number
    maxModelCalls: number
    timeoutMs: number
  }
  quotas?: {
    userPerMinute: number
    globalPerMinute: number
    dailyRuns: number
    retentionDays: number
  }
}

interface AgentStep {
  id: string
  seq: number
  kind: 'model' | 'tool' | 'validation'
  name: string
  status: 'succeeded' | 'failed'
  input: unknown
  output: unknown
  durationMs: number
  createdAt: string
}

type AgentRunStatus = 'running' | 'succeeded' | 'waiting_human' | 'failed' | 'cancelled'

interface AgentRun {
  id: string
  question: string
  status: AgentRunStatus
  mode: 'agent' | 'fallback'
  answer: string
  error: string | null
  createdAt: string
  completedAt: string | null
  steps: AgentStep[]
}

interface AgentRunSummary {
  id: string
  question: string
  status: AgentRunStatus
  mode: 'agent' | 'fallback'
  createdAt: string
  completedAt: string | null
  stepCount: number
}

interface AgentRunList {
  items: AgentRunSummary[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

const EXAMPLES = [
  { label: '统计闭环', question: '统计本月成品车间闭环情况' },
  { label: '筛选隐患', question: '查找待复查的重大隐患' },
  { label: '检索法规', question: '检索电气安全相关法规' },
  { label: '跨范围比较', question: '比较成品车间和其他车间本月隐患闭环情况' },
]

const RUN_STATUS = {
  running: { label: '正在分析', className: 'bg-[#007AFF]/10 text-[#007AFF]' },
  succeeded: { label: '已完成', className: 'bg-[#34C759]/10 text-[#248A3D]' },
  waiting_human: { label: '等待人工', className: 'bg-[#FF9500]/10 text-[#B25000]' },
  failed: { label: '运行失败', className: 'bg-[#FF3B30]/10 text-[#D70015]' },
  cancelled: { label: '已取消', className: 'bg-neutral-100 text-neutral-500' },
} as const

const STEP_KIND = {
  model: { label: '模型', icon: BrainCircuit, className: 'bg-[#007AFF]/10 text-[#007AFF]' },
  tool: { label: '工具', icon: Wrench, className: 'bg-[#FF9500]/10 text-[#B25000]' },
  validation: { label: '验证', icon: ShieldCheck, className: 'bg-[#34C759]/10 text-[#248A3D]' },
} as const

const TOOL_LABELS: Record<string, string> = {
  search_issues: '检索隐患',
  get_issue: '读取隐患详情',
  aggregate_safety_metrics: '聚合安全指标',
  search_regulations: '检索法规制度',
}

const VALIDATION_LABELS: Record<string, string> = {
  evidence_required: '工具证据必要性检查',
  evidence_check: '回答证据验收',
  run_cancelled: '运行取消记录',
  run_failed: '运行失败记录',
  budget_exhausted: '运行预算检查',
  deterministic_fallback: '规则降级结果验收',
}

const TRACE_KEY_LABELS: Record<string, string> = {
  query: '关键词', status: '状态', scope: '统计范围', riskLevel: '风险等级', reviewed: '复核状态',
  limit: '返回上限', start: '开始时间', end: '结束时间', issueId: '隐患编号',
  total: '总数', returned: '本次返回数', items: '记录列表', id: '编号', title: '标题',
  description: '描述', stage: '业务阶段', foundAt: '发现时间', deadline: '整改期限',
  closedAt: '闭环时间', recheckRequired: '要求复查次数', rechecks: '复查记录',
  fixNote: '整改说明', institutionNote: '制度沉淀说明', regulations: '关联法规',
  articleNo: '条款号', summary: '摘要', category: '分类', updatedAt: '更新时间',
  generatedAt: '生成时间', period: '统计周期', startInclusive: '包含开始边界', endInclusive: '包含结束边界',
  open: '未闭环', closed: '已闭环', overdue: '已超期', closureRate: '闭环率（小数）',
  discoveredClosureRate: '发现闭环率（百分比）', dueClosureRate: '按期闭环率（百分比）',
  dueTotal: '到期任务总数', dueClosedOnTime: '按期闭环数', byStatus: '按状态统计', byRiskLevel: '按风险统计',
  metricVersion: '指标口径版本', promptVersion: '提示词版本', modelCall: '模型调用序号',
  finishReason: '结束原因', content: '模型回答', proposedTools: '建议调用工具', usage: '模型用量',
  prompt_tokens: '输入令牌数', completion_tokens: '输出令牌数', total_tokens: '总令牌数',
  answerLength: '回答长度', checkedNumbers: '已核验数字', citedIds: '已核验引用编号',
  ok: '是否通过', reason: '原因', evidenceSteps: '证据步骤序号', error: '错误信息',
  maxSteps: '最大步骤数', maxModelCalls: '最大模型调用数', pending: '待整改', fixing: '整改中',
  review: '待复查', general: '一般', major: '重大', critical: '严重', immediate: '立即处理',
}

const TRACE_VALUE_LABELS: Record<string, string> = {
  pending: '待整改', fixing: '整改中', review: '待复查', closed: '已闭环',
  managed: '成品车间', reference: '其他车间', all: '全部范围',
  general: '一般', major: '重大', critical: '严重', immediate: '立即处理',
  agent: '模型协作模式', fallback: '规则降级模式', stop: '正常结束', tool_calls: '请求调用工具',
  length: '达到长度限制', content_filter: '内容被过滤', fix: '整改', recheck: '复查', institution: '制度沉淀',
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function stepDisplayName(step: AgentStep) {
  if (step.kind === 'tool') return TOOL_LABELS[step.name] ?? '未声明的只读工具'
  if (step.kind === 'model') return '模型推理'
  return VALIDATION_LABELS[step.name] ?? '运行结果验证'
}

const TEXT_REPLACEMENTS: [RegExp, string][] = [
  [/This operation was aborted/gi, '模型响应超时，本次请求已中止'],
  [/https?:\/\/\S+/gi, '由服务端安全配置的接口地址'],
  [/deepseek-chat/gi, '深度求索对话模型'],
  [/DeepSeek/g, '深度求索'],
  [/OpenAI/g, '开放对话'],
  [/agent-readonly-v(\d+)/gi, '只读分析提示词第 $1 版'],
  [/safety-v(\d+)/gi, '安全指标第 $1 版'],
  [/aggregate_safety_metrics/g, '聚合安全指标'],
  [/search_regulations/g, '检索法规制度'],
  [/search_issues/g, '检索隐患'],
  [/get_issue/g, '读取隐患详情'],
  [/evidence_check/g, '回答证据验收'],
  [/evidence_required/g, '工具证据必要性检查'],
  [/budget_exhausted/g, '运行预算耗尽'],
  [/discoveredClosureRate/g, '发现闭环率'],
  [/dueClosureRate/g, '按期闭环率'],
  [/dueClosedOnTime/g, '按期闭环数'],
  [/dueTotal/g, '到期任务总数'],
  [/closureRate/g, '闭环率'],
  [/byRiskLevel/g, '按风险统计'],
  [/byStatus/g, '按状态统计'],
  [/metricVersion/g, '指标口径版本'],
  [/promptVersion/g, '提示词版本'],
  [/\boverdue\b/g, '超期数'],
  [/\bgeneral\b/g, '一般'],
  [/\bmajor\b/g, '重大'],
  [/\bcritical\b/g, '严重'],
  [/\bimmediate\b/g, '立即处理'],
  [/\btotal\b/g, '总数'],
  [/\btool_calls\b/g, '请求调用工具'],
  [/\bwaiting_human\b/g, '等待人工复核'],
  [/\bsucceeded\b/g, '成功'],
  [/\bfailed\b/g, '失败'],
  [/\brunning\b/g, '运行中'],
  [/\bcancelled\b/g, '已取消'],
  [/\bpending\b/g, '待整改'],
  [/\bfixing\b/g, '整改中'],
  [/\breview\b/g, '待复查'],
  [/\bclosed\b/g, '已闭环'],
  [/\bmanaged\b/g, '成品车间'],
  [/\breference\b/g, '其他车间'],
  [/\bfallback\b/g, '规则降级'],
  [/\bAgent\b/g, '智能助手'],
  [/\bID\b/g, '编号'],
]

const INTERNAL_RECORD_CODE = /\bc[a-z0-9]{20,}\b/gi

function humanizeText(value: string) {
  const withoutInternalCodes = value.replace(INTERNAL_RECORD_CODE, '记录')
  return TEXT_REPLACEMENTS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), withoutInternalCodes)
}

/** 内部编号仅在本次回答中转为顺序标签，原始回答与证据验收数据保持不变。 */
function humanizeAnswer(answer: string) {
  const labels = new Map<string, number>()
  const readableAnswer = answer.replace(INTERNAL_RECORD_CODE, (code) => {
    const key = code.toLowerCase()
    if (!labels.has(key)) labels.set(key, labels.size + 1)
    return `隐患 ${labels.get(key)}`
  })
  return humanizeText(readableAnswer)
}

function modelDisplayName(model: string) {
  return /deepseek/i.test(model) ? '深度求索对话模型' : '服务端配置的对话模型'
}

function FormattedAnswer({ answer }: { answer: string }) {
  return (
    <div className="mt-2 min-w-0 text-[15px] leading-8 text-neutral-700">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h4 className="mb-2 mt-5 text-[16px] font-semibold leading-7 text-neutral-900 first:mt-0">{children}</h4>,
          h2: ({ children }) => <h4 className="mb-2 mt-5 text-[16px] font-semibold leading-7 text-neutral-900 first:mt-0">{children}</h4>,
          h3: ({ children }) => <h4 className="mb-2 mt-4 text-[15px] font-semibold leading-7 text-neutral-900 first:mt-0">{children}</h4>,
          h4: ({ children }) => <h4 className="mb-2 mt-4 text-[15px] font-semibold leading-7 text-neutral-900 first:mt-0">{children}</h4>,
          p: ({ children }) => <p className="mt-3 whitespace-normal break-words first:mt-0">{children}</p>,
          ul: ({ children }) => <ul className="mt-3 list-disc space-y-2 pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="mt-3 list-decimal space-y-2 pl-6">{children}</ol>,
          li: ({ children }) => <li className="pl-1 marker:text-neutral-400">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-neutral-900">{children}</strong>,
          blockquote: ({ children }) => <blockquote className="my-3 rounded-lg bg-neutral-50 px-4 py-2">{children}</blockquote>,
          hr: () => <hr className="my-5 border-neutral-200" />,
          table: ({ children }) => <div className="mt-3 overflow-x-auto"><table className="w-full border-collapse text-left text-[13px] leading-6">{children}</table></div>,
          th: ({ children }) => <th className="border-b border-neutral-300 bg-neutral-50 px-3 py-2 font-medium text-neutral-800">{children}</th>,
          td: ({ children }) => <td className="border-b border-neutral-200 px-3 py-2 align-top">{children}</td>,
          code: ({ children }) => <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-[13px] text-neutral-800">{children}</code>,
          pre: ({ children }) => <pre className="mt-3 max-w-full overflow-auto rounded-lg bg-neutral-50 p-3 text-[13px] leading-6">{children}</pre>,
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-[#007AFF] underline underline-offset-2">{children}</a>,
        }}
      >
        {humanizeAnswer(answer)}
      </ReactMarkdown>
    </div>
  )
}

function translateTraceValue(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => key === 'proposedTools' && typeof item === 'string'
      ? TOOL_LABELS[item] ?? '未声明的只读工具'
      : translateTraceValue(item))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue], index) => [
      TRACE_KEY_LABELS[childKey] ?? `其他字段 ${index + 1}`,
      translateTraceValue(childValue, childKey),
    ]))
  }
  if (typeof value === 'string') {
    if (/(?:At|start|end|deadline)$/.test(key) && !Number.isNaN(new Date(value).getTime())) return formatTime(value)
    return humanizeText(TRACE_VALUE_LABELS[value] ?? value)
  }
  return value
}

function TraceValueView({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-neutral-400">无</span>
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>
  if (typeof value === 'number') return <span className="tabular-nums">{value}</span>
  if (typeof value === 'string') return <span className="whitespace-pre-wrap break-words">{humanizeText(value)}</span>
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-neutral-400">无记录</span>
    return (
      <ol className="space-y-3">
        {value.map((item, index) => (
          <li key={index} className="grid grid-cols-[24px_minmax(0,1fr)] gap-2">
            <span className="text-neutral-400 tabular-nums">{index + 1}.</span>
            <div className="min-w-0"><TraceValueView value={item} /></div>
          </li>
        ))}
      </ol>
    )
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return <span className="text-neutral-400">无内容</span>
  return (
    <dl className="min-w-0">
      {entries.map(([childKey, childValue], index) => (
        <div key={`${childKey}-${index}`} className="grid gap-1 border-b border-dashed border-neutral-200 py-2.5 first:pt-0 last:border-0 last:pb-0 sm:grid-cols-[112px_minmax(0,1fr)] sm:gap-4">
          <dt className="shrink-0 text-neutral-500">{humanizeText(childKey)}</dt>
          <dd className="min-w-0 text-neutral-800"><TraceValueView value={childValue} /></dd>
        </div>
      ))}
    </dl>
  )
}

function stepSummary(step: AgentStep) {
  const output = step.output && typeof step.output === 'object' && !Array.isArray(step.output)
    ? step.output as Record<string, unknown>
    : {}
  if (step.status === 'failed' && typeof output.error === 'string') return humanizeText(output.error)
  if (typeof output.reason === 'string') return humanizeText(output.reason)
  if (step.kind === 'validation') return output.ok === true ? '本次回答已通过证据核验。' : '验证节点已执行，请查看详细结果。'
  if (step.kind === 'model') {
    if (Array.isArray(output.proposedTools) && output.proposedTools.length) {
      return `模型建议调用：${output.proposedTools.map((tool) => TOOL_LABELS[String(tool)] ?? '只读查询工具').join('、')}。`
    }
    return '模型已完成本轮分析并生成回答。'
  }
  if (step.name === 'aggregate_safety_metrics' && typeof output.total === 'number') {
    return `统计完成：共 ${output.total} 条，已闭环 ${Number(output.closed ?? 0)} 条，未闭环 ${Number(output.open ?? 0)} 条。`
  }
  if (typeof output.total === 'number') return `共找到 ${output.total} 条记录，本次返回 ${Number(output.returned ?? 0)} 条。`
  if (typeof output.title === 'string') return `已读取：${output.title}`
  return '只读工具已执行完成。'
}

function formatDuration(durationMs: number) {
  return durationMs < 1000 ? `${durationMs} 毫秒` : `${(durationMs / 1000).toFixed(2)} 秒`
}

function formatTime(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? humanizeText(iso) : date.toLocaleString('zh-CN', { hour12: false })
}

interface AgentProps {
  embedded?: boolean
  draftRequest?: { question: string; id: number }
}

export default function Agent({ embedded = false, draftRequest }: AgentProps) {
  const isAdmin = getCurrentUser()?.role === 'admin'
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null)
  const [capabilitiesError, setCapabilitiesError] = useState('')
  const [question, setQuestion] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [run, setRun] = useState<AgentRun | null>(null)
  const [detailCollapsed, setDetailCollapsed] = useState(false)
  const [selectedStepId, setSelectedStepId] = useState('')
  const [error, setError] = useState('')
  const [runError, setRunError] = useState('')
  const [history, setHistory] = useState<AgentRunList | null>(null)
  const [historyPage, setHistoryPage] = useState(1)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [historyLoadingId, setHistoryLoadingId] = useState('')
  const submittingRef = useRef(false)
  const cancellingRef = useRef(false)
  const runId = run?.id
  const runStatus = run?.status

  const loadHistory = useCallback(async (page: number, quiet = false) => {
    if (!quiet) setHistoryLoading(true)
    setHistoryError('')
    try {
      const result = await api<AgentRunList>(`/agent/runs?page=${page}&pageSize=10`)
      setHistory(result)
      setHistoryPage(result.page)
    } catch (loadError) {
      setHistoryError(errorMessage(loadError, '无法读取历史调用记录'))
    } finally {
      if (!quiet) setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHistory(1)
  }, [loadHistory])

  useEffect(() => {
    if (!isAdmin || embedded) return
    let active = true

    const loadCapabilities = async () => {
      try {
        const data = await api<AgentCapabilities>('/agent/capabilities')
        if (active) setCapabilities(data)
      } catch (loadError) {
        if (active) setCapabilitiesError(errorMessage(loadError, '无法读取模型配置'))
      }
    }

    void loadCapabilities()
    return () => { active = false }
  }, [embedded, isAdmin])

  useEffect(() => {
    if (!draftRequest) return
    setQuestion(draftRequest.question)
    setError('')
    const timer = window.setTimeout(() => {
      const input = document.getElementById('agent-question')
      input?.focus()
      input?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [draftRequest])

  useEffect(() => {
    if (!runId || runStatus !== 'running') return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const result = await api<AgentRun>(`/agent/runs/${runId}`)
        if (!active) return
        setRunError('')
        setRun((current) => current?.id === runId && current.status !== 'cancelled' ? result : current)
        if (result.status !== 'running') void loadHistory(historyPage, true)
      } catch (pollError) {
        if (active) setRunError(errorMessage(pollError, '暂时无法刷新运行状态'))
      } finally {
        if (active) timer = setTimeout(poll, 500)
      }
    }

    void poll()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [historyPage, loadHistory, runId, runStatus])

  const submitQuestion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedQuestion = question.trim()
    if (!trimmedQuestion || submittingRef.current || run?.status === 'running') return

    submittingRef.current = true
    setSubmitting(true)
    setError('')
    setRunError('')
    setRun(null)
    setDetailCollapsed(false)
    setSelectedStepId('')
    try {
      const result = await api<AgentRun>('/agent/runs', {
        method: 'POST',
        body: JSON.stringify({ question: trimmedQuestion }),
      })
      setRun(result)
    } catch (submitError) {
      setError(errorMessage(submitError, '分析请求失败，请稍后重试'))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const cancelRun = async () => {
    if (!run || run.status !== 'running' || cancellingRef.current) return
    cancellingRef.current = true
    setCancelling(true)
    setRunError('')
    try {
      const result = await api<AgentRun>(`/agent/runs/${run.id}/cancel`, { method: 'POST' })
      setRun(result)
      void loadHistory(historyPage, true)
    } catch (cancelError) {
      setRunError(errorMessage(cancelError, '取消失败，请刷新运行状态后重试'))
    } finally {
      cancellingRef.current = false
      setCancelling(false)
    }
  }

  const openHistoryRun = async (id: string) => {
    if (historyLoadingId) return
    setHistoryLoadingId(id)
    setRunError('')
    try {
      const result = await api<AgentRun>(`/agent/runs/${id}`)
      setRun(result)
      setDetailCollapsed(false)
      setSelectedStepId('')
      window.setTimeout(() => document.getElementById('agent-run-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
    } catch (loadError) {
      setHistoryError(errorMessage(loadError, '无法读取这次调用的完整轨迹'))
    } finally {
      setHistoryLoadingId('')
    }
  }

  const running = run?.status === 'running'
  const steps = run ? [...run.steps].sort((a, b) => a.seq - b.seq) : []
  const selectedStep = steps.find((step) => step.id === selectedStepId) ?? null
  const lastStep = steps.at(-1)
  const lastOutput = lastStep?.output && typeof lastStep.output === 'object' && !Array.isArray(lastStep.output)
    ? lastStep.output as Record<string, unknown>
    : {}
  const runningStepName = !lastStep
    ? '模型推理'
    : lastStep.kind === 'tool'
      ? '模型推理'
      : lastStep.kind === 'validation'
        ? '整理执行结果'
        : Array.isArray(lastOutput.proposedTools) && lastOutput.proposedTools.length
          ? '调用只读工具'
          : '验证回答依据'

  const toggleStep = (id: string) => {
    setSelectedStepId((current) => current === id ? '' : id)
  }

  const moveStepSelection = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offset = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
    if (!offset) return
    event.preventDefault()
    const nextStep = steps[(index + offset + steps.length) % steps.length]
    setSelectedStepId(nextStep.id)
    document.getElementById(`agent-step-${nextStep.id}`)?.focus()
  }

  return (
    <div className={embedded ? 'space-y-5' : 'mx-auto max-w-5xl space-y-5 px-1 py-2 sm:px-4 sm:py-6'}>
      {!embedded && (
        <header className="flex items-center gap-2">
          <Bot size={23} className="text-[#007AFF]" />
          <h1 className="text-[22px] font-bold tracking-tight text-neutral-900">Agent 检索</h1>
        </header>
      )}

      {!embedded && isAdmin && (capabilitiesError ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl bg-[#FF9500]/10 px-4 py-3 text-[13px] text-[#8A4700]">
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          <span>模型配置读取失败：{humanizeText(capabilitiesError)}。仍可尝试提交问题。</span>
        </div>
      ) : capabilities ? (
        <details className="group rounded-2xl border border-neutral-100 bg-white shadow-sm">
          <summary className="flex min-h-14 cursor-pointer select-none list-none items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-[#007AFF]/30">
            <span className={`h-2 w-2 shrink-0 rounded-full ${capabilities.llmConfigured ? 'bg-[#34C759]' : 'bg-[#FF9500]'}`} />
            <span className="text-[13px] font-medium text-neutral-800">模型配置</span>
            <span className="ml-auto hidden text-[12px] text-neutral-500 sm:inline">{capabilities.llmConfigured ? '模型已配置' : '使用规则降级'}</span>
            <ChevronDown size={15} className="shrink-0 text-neutral-400 transition-transform duration-150 group-open:rotate-180" />
          </summary>
          <div className="border-t border-neutral-100 px-4 pb-4 pt-3">
            <dl className="grid gap-x-6 gap-y-3 text-[12px] sm:grid-cols-2">
              <div className="flex gap-3"><dt className="shrink-0 text-neutral-400">当前模型</dt><dd className="text-neutral-700">{capabilities.llm ? modelDisplayName(capabilities.llm.model) : '未配置'}</dd></div>
              <div className="flex gap-3"><dt className="shrink-0 text-neutral-400">接入方式</dt><dd className="text-neutral-700">对话兼容接口，密钥{capabilities.llmConfigured ? '已安全配置' : '未配置'}</dd></div>
            </dl>
            <div className="mt-4 border-t border-neutral-100 pt-3">
              <div className="mb-2 text-[12px] font-medium text-neutral-500">可用工具（均为只读）</div>
              {capabilities.tools.length > 0 ? (
                <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  {(capabilities.toolCatalog ?? capabilities.tools.map((id) => ({ id, label: TOOL_LABELS[id] ?? '只读查询工具', description: '执行服务端限定的只读查询。' }))).map((tool) => (
                    <div key={tool.id}>
                      <div className="text-[13px] font-medium text-neutral-800">{tool.label}</div>
                      <p className="mt-0.5 text-[12px] leading-5 text-neutral-500">{tool.description}</p>
                    </div>
                  ))}
                </div>
              ) : <span className="text-[12px] text-neutral-400">未声明工具</span>}
            </div>
          </div>
        </details>
      ) : (
        <div className="flex items-center gap-2 px-1 text-[12px] text-neutral-400">
          <Loader2 size={14} className="animate-spin" /> 正在读取模型配置…
        </div>
      ))}

      <form onSubmit={submitQuestion} className="rounded-2xl border border-neutral-100 bg-white p-4 shadow-sm sm:p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap gap-2" aria-label="快捷问题">
            {EXAMPLES.map((example) => (
              <button
                key={example.label}
                type="button"
                title={example.question}
                aria-pressed={question === example.question}
                disabled={submitting || running}
                onClick={() => setQuestion(example.question)}
                className={`rounded-full border px-3 py-1.5 text-left text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${question === example.question ? 'border-[#007AFF]/30 bg-[#007AFF]/10 text-[#007AFF]' : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-800'}`}
              >
                {example.label}
              </button>
            ))}
          </div>
          <span className="ml-auto text-[11px] tabular-nums text-neutral-400">{question.length} / 1000</span>
        </div>
        <textarea
          id="agent-question"
          aria-label="你的问题"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={1000}
          rows={4}
          placeholder="输入要统计、查找或检索的问题…"
          className="min-h-28 w-full resize-y rounded-xl bg-neutral-50 px-4 py-3 text-[14px] leading-6 text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:bg-neutral-100 focus:ring-2 focus:ring-[#007AFF]/20"
        />
        <div className="mt-3 flex justify-end">
          <button
            type="submit"
            disabled={submitting || running || !question.trim()}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#007AFF] px-5 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-[#006EE6] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            {submitting ? '提交中…' : running ? '分析进行中' : '开始分析'}
          </button>
        </div>
      </form>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl bg-[#FF3B30]/10 px-4 py-3 text-[13px] text-[#D70015]">
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          <span>提交失败：{error}。输入内容已保留，可调整后重试。</span>
        </div>
      )}

      {runError && (
        <div role="alert" className="flex items-start gap-2 rounded-xl bg-[#FF9500]/10 px-4 py-3 text-[13px] text-[#8A4700]">
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          <span>{runError}。现有回答和轨迹会继续保留。</span>
        </div>
      )}

      {(submitting || running) && (
        <div role="status" className="flex items-center gap-3 rounded-2xl border border-neutral-100 bg-white px-5 py-4 shadow-sm">
          <Loader2 size={18} className="shrink-0 animate-spin text-[#007AFF]" />
          <div>
            <div className="text-[14px] font-medium text-neutral-800">{submitting ? '正在创建分析任务' : '正在分析，可取消'}</div>
            <p className="mt-0.5 text-[12px] text-neutral-400">
              {submitting ? '创建成功后将自动刷新进度。' : '页面会自动轮询状态，并逐步展示真实回答与执行轨迹。'}
            </p>
          </div>
        </div>
      )}

      {run && !detailCollapsed && (
        <>
          <section id="agent-run-detail" className="scroll-mt-4 rounded-2xl border border-neutral-100 bg-white p-5 shadow-sm sm:p-6" aria-live="polite" aria-labelledby="agent-result-title">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex min-w-0 items-center gap-2">
                {run.status === 'succeeded' ? <CheckCircle2 size={20} className="shrink-0 text-[#248A3D]" /> : <Sparkles size={20} className="shrink-0 text-[#007AFF]" />}
                <h2 id="agent-result-title" className="text-[17px] font-semibold text-neutral-900">执行结果</h2>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${RUN_STATUS[run.status].className}`}>{RUN_STATUS[run.status].label}</span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {running && (
                  <button
                    type="button"
                    onClick={cancelRun}
                    disabled={cancelling}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-neutral-200 px-3 text-[12px] font-medium text-neutral-600 transition-colors hover:border-[#FF3B30]/30 hover:bg-[#FF3B30]/5 hover:text-[#D70015] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF3B30]/30 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {cancelling ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} />}
                    {cancelling ? '取消中…' : '取消运行'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setDetailCollapsed(true)
                    window.setTimeout(() => document.getElementById('agent-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
                  }}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-neutral-200 px-3 text-[12px] font-medium text-neutral-600 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#007AFF]/30"
                >
                  <ChevronUp size={14} /> 收起结果
                </button>
              </div>
            </div>

            <div className="mt-5 border-b border-neutral-100 pb-5">
              <div className="text-[12px] font-medium text-neutral-400">本次问题</div>
              <p className="mt-2 whitespace-pre-wrap break-words text-[15px] font-medium leading-7 text-neutral-900">{run.question}</p>
            </div>

            {run.mode === 'fallback' && (
              <div className="mt-4 rounded-xl bg-[#FF9500]/10 px-4 py-3 text-[13px] leading-6 text-[#8A4700]">
                当前未配置模型，本次由固定查询规则完成。
              </div>
            )}

            {run.error && (
              <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl bg-[#FF3B30]/10 px-4 py-3 text-[13px] leading-6 text-[#D70015]">
                <CircleAlert size={16} className="mt-1 shrink-0" /> {humanizeText(run.error)}
              </div>
            )}

            <div className="mt-5">
              <h3 className="text-[14px] font-semibold text-neutral-900">{running ? '当前进展' : '分析结论'}</h3>
              {run.answer ? (
                <FormattedAnswer answer={run.answer} />
              ) : (
                <p className="mt-2 text-[14px] leading-7 text-neutral-400">{running ? '正在分析，尚未形成结论。' : '本次运行没有形成结论。'}</p>
              )}
              {run.status === 'succeeded' && <p className="mt-3 text-[12px] leading-6 text-[#248A3D]">结论已通过系统核验，可在下方流程中查看依据。</p>}
              {run.status === 'waiting_human' && <p className="mt-3 text-[12px] leading-6 text-[#8A4700]">本次内容不作为系统结论，请查看验证节点的原因说明，调整问题后重试或转人工复核。</p>}
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 border-t border-neutral-100 pt-4 text-[12px] lg:grid-cols-4">
              <div><dt className="text-neutral-400">发起时间</dt><dd className="mt-1 text-neutral-700">{formatTime(run.createdAt)}</dd></div>
              <div><dt className="text-neutral-400">完成时间</dt><dd className="mt-1 text-neutral-700">{run.completedAt ? formatTime(run.completedAt) : running ? '进行中' : '未记录'}</dd></div>
              <div><dt className="text-neutral-400">分析方式</dt><dd className="mt-1 text-neutral-700">{run.mode === 'agent' ? '智能分析' : '规则分析'}</dd></div>
              <div><dt className="text-neutral-400">执行进度</dt><dd className="mt-1 text-neutral-700">{steps.length} 个节点</dd></div>
            </dl>
          </section>

          <section className="rounded-2xl border border-neutral-100 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="agent-steps-title">
            <div className="border-b border-neutral-100 pb-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="agent-steps-title" className="text-[16px] font-semibold text-neutral-900">执行流程</h2>
                <span className="text-[12px] text-neutral-400">已完成 {steps.length} 个节点{running ? '，下一节点执行中' : ''}</span>
              </div>
              {steps.length > 0 && <p className="mt-1.5 text-[12px] leading-5 text-neutral-500">节点完成后会立即显示。点击节点展开详情，再次点击即可收回。</p>}
            </div>
            {steps.length > 0 || running ? (
              <>
                <ol aria-label="智能助手执行节点" aria-live="polite" aria-relevant="additions" className="mt-6 grid gap-4 md:grid-flow-col md:auto-cols-fr md:gap-0">
                  {steps.map((step, index) => {
                    const selected = selectedStep?.id === step.id
                    const succeeded = step.status === 'succeeded'
                    return (
                      <li
                        key={step.id}
                        className={`relative motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300 ${index > 0 ? "before:absolute before:bottom-1/2 before:left-[21px] before:h-full before:w-px before:bg-neutral-200 before:content-[''] md:before:bottom-auto md:before:left-auto md:before:right-1/2 md:before:top-[22px] md:before:h-px md:before:w-full" : ''}`}
                      >
                        <button
                          id={`agent-step-${step.id}`}
                          type="button"
                          data-step-seq={step.seq}
                          aria-expanded={selected}
                          aria-controls={selected ? 'agent-step-detail' : undefined}
                          aria-label={`步骤 ${step.seq}：${stepDisplayName(step)}，${succeeded ? '成功' : '失败'}，耗时 ${formatDuration(step.durationMs)}。${selected ? '再次点击收回详情' : '点击查看详情'}`}
                          onClick={() => toggleStep(step.id)}
                          onKeyDown={(event) => moveStepSelection(event, index)}
                          className="group relative z-10 flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[#007AFF]/40 focus-visible:ring-offset-4 md:flex-col md:gap-2 md:text-center"
                        >
                          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 text-[14px] font-semibold tabular-nums transition-[color,background-color,border-color,box-shadow] duration-150 md:mx-auto ${selected ? 'border-[#007AFF] bg-[#007AFF] text-white ring-4 ring-[#007AFF]/10' : succeeded ? 'border-[#007AFF] bg-white text-[#007AFF] group-hover:bg-[#007AFF]/5' : 'border-[#FF3B30] bg-[#FF3B30]/5 text-[#D70015]'}`}>
                            {selected ? <ChevronUp size={18} aria-hidden="true" /> : step.seq}
                          </span>
                          <span className="min-w-0 flex-1 md:flex-none">
                            <span className={`block break-words text-[12px] font-medium leading-5 ${selected ? 'text-[#007AFF]' : 'text-neutral-800'}`}>{stepDisplayName(step)}</span>
                            <span className={`mt-0.5 flex items-center gap-1 text-[11px] tabular-nums md:justify-center ${succeeded ? 'text-[#248A3D]' : 'text-[#D70015]'}`}>
                              <span className={`h-1.5 w-1.5 rounded-full ${succeeded ? 'bg-[#34C759]' : 'bg-[#FF3B30]'}`} />
                              {succeeded ? '成功' : '失败'}
                              <span className="text-neutral-400">· {formatDuration(step.durationMs)}</span>
                            </span>
                            {selected && <span className="mt-1 block text-[11px] font-medium text-[#007AFF]">再次点击收回</span>}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                  {running && (
                    <li role="status" aria-label={`正在执行：${runningStepName}`} className={`relative ${steps.length > 0 ? "before:absolute before:bottom-1/2 before:left-[21px] before:h-full before:w-px before:bg-neutral-200 before:content-[''] md:before:bottom-auto md:before:left-auto md:before:right-1/2 md:before:top-[22px] md:before:h-px md:before:w-full" : ''}`}>
                      <div className="relative z-10 flex min-h-11 w-full items-center gap-3 rounded-lg text-left md:flex-col md:gap-2 md:text-center">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-[#007AFF]/40 bg-[#007AFF]/5 text-[#007AFF] md:mx-auto">
                          <Loader2 size={19} className="animate-spin" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1 md:flex-none">
                          <span className="block break-words text-[12px] font-medium leading-5 text-[#007AFF]">{runningStepName}</span>
                          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-neutral-400 md:justify-center">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#007AFF]" /> 正在执行
                          </span>
                        </span>
                      </div>
                    </li>
                  )}
                </ol>

                {selectedStep && (
                  <div id="agent-step-detail" key={selectedStep.id} data-step-id={selectedStep.id} className="mt-6 border-t border-neutral-200 pt-5" role="region" aria-label={`第 ${selectedStep.seq} 步详细执行情况`}>
                    {(() => {
                      const kind = STEP_KIND[selectedStep.kind]
                      const KindIcon = kind.icon
                      const inputLabel = selectedStep.kind === 'tool' ? '工具输入参数' : selectedStep.kind === 'model' ? '模型调用信息' : '验证输入信息'
                      const outputLabel = selectedStep.kind === 'tool' ? '工具返回内容' : selectedStep.kind === 'model' ? '模型返回内容' : '验证结果详情'
                      return (
                        <>
                          <div className="flex flex-wrap items-center gap-2.5">
                            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-[#007AFF] text-[12px] font-semibold tabular-nums text-[#007AFF]">{selectedStep.seq}</span>
                            <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${kind.className} bg-transparent px-0`}>
                              <KindIcon size={14} /> {kind.label}
                            </span>
                            <h3 className="min-w-0 break-words text-[15px] font-semibold text-neutral-900">{stepDisplayName(selectedStep)}</h3>
                            <button
                              type="button"
                              onClick={() => setSelectedStepId('')}
                              className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-neutral-200 px-3 text-[12px] font-medium text-neutral-600 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#007AFF]/30"
                            >
                              <ChevronUp size={14} /> 收起节点详情
                            </button>
                          </div>

                          <p className="mt-4 rounded-xl bg-[#F5F6F2] px-4 py-3 text-[14px] leading-7 text-neutral-800">{stepSummary(selectedStep)}</p>
                          <dl className="mt-4 grid gap-3 border-b border-neutral-100 pb-4 text-[12px] sm:grid-cols-3">
                            <div><dt className="text-neutral-400">执行状态</dt><dd className={`mt-1 font-medium ${selectedStep.status === 'succeeded' ? 'text-[#248A3D]' : 'text-[#D70015]'}`}>{selectedStep.status === 'succeeded' ? '执行成功' : '执行失败'}</dd></div>
                            <div><dt className="text-neutral-400">执行耗时</dt><dd className="mt-1 tabular-nums text-neutral-700">{formatDuration(selectedStep.durationMs)}</dd></div>
                            <div><dt className="text-neutral-400">执行时间</dt><dd className="mt-1 text-neutral-700">{formatTime(selectedStep.createdAt)}</dd></div>
                          </dl>

                          <div className="mt-4 grid gap-3 lg:grid-cols-2">
                            <details className="group min-w-0 rounded-xl bg-[#F5F6F2] px-4">
                              <summary className="flex min-h-12 cursor-pointer select-none list-none items-center gap-2 text-[13px] font-medium text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-[#007AFF]/40">
                                {inputLabel}<ChevronDown size={14} className="ml-auto text-neutral-400 transition-transform duration-150 group-open:rotate-180" />
                              </summary>
                              <div className="max-h-80 overflow-auto border-t border-neutral-200 py-3 text-[13px] leading-6"><TraceValueView value={translateTraceValue(selectedStep.input)} /></div>
                            </details>
                            <details open className="group min-w-0 rounded-xl bg-[#F5F6F2] px-4">
                              <summary className="flex min-h-12 cursor-pointer select-none list-none items-center gap-2 text-[13px] font-medium text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-[#007AFF]/40">
                                {outputLabel}<ChevronDown size={14} className="ml-auto text-neutral-400 transition-transform duration-150 group-open:rotate-180" />
                              </summary>
                              <div className="max-h-80 overflow-auto border-t border-neutral-200 py-3 text-[13px] leading-6"><TraceValueView value={translateTraceValue(selectedStep.output)} /></div>
                            </details>
                          </div>
                        </>
                      )
                    })()}
                  </div>
                )}
              </>
            ) : (
              <div className="px-5 py-6 text-center text-[13px] text-neutral-400">本次运行没有返回步骤记录。</div>
            )}
          </section>
        </>
      )}

      <section id="agent-history" className="rounded-2xl border border-neutral-100 bg-white p-5 shadow-sm" aria-labelledby="agent-history-title">
        <div className="flex flex-wrap items-center gap-3 border-b border-neutral-100 pb-4">
          <History size={18} className="text-[#007AFF]" />
          <div>
            <h2 id="agent-history-title" className="text-[15px] font-semibold text-neutral-900">历史调用记录</h2>
            <p className="mt-0.5 text-[12px] text-neutral-400">仅显示本人记录，保留 90 天；选择一条可回看完整执行轨迹</p>
          </div>
          <button
            type="button"
            onClick={() => void loadHistory(historyPage)}
            disabled={historyLoading}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2 text-[12px] text-neutral-600 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw size={13} className={historyLoading ? 'animate-spin' : ''} /> 刷新
          </button>
        </div>
        {historyError && (
          <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl bg-[#FF9500]/10 px-3.5 py-2.5 text-[12px] text-[#8A4700]">
            <CircleAlert size={15} className="mt-0.5 shrink-0" /> {historyError}
          </div>
        )}
        {historyLoading && !history ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-neutral-400"><Loader2 size={15} className="animate-spin" /> 正在读取历史记录…</div>
        ) : history && history.items.length > 0 ? (
          <>
            <ol className="divide-y divide-neutral-100">
              {history.items.map((item) => (
                <li key={item.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${RUN_STATUS[item.status].className}`}>{RUN_STATUS[item.status].label}</span>
                      <span className="text-[11px] text-neutral-400">{item.mode === 'agent' ? '智能分析' : '规则分析'}</span>
                      {run?.id === item.id && !detailCollapsed && <span className="text-[11px] font-medium text-[#007AFF]">当前查看</span>}
                    </div>
                    <p className="mt-2 line-clamp-2 break-words text-[13px] leading-5 text-neutral-800">{item.question}</p>
                    <div className="mt-1.5 text-[11px] text-neutral-400">{formatTime(item.createdAt)} · {item.stepCount} 个步骤</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void openHistoryRun(item.id)}
                    disabled={Boolean(historyLoadingId)}
                    className="inline-flex shrink-0 items-center justify-center gap-1.5 self-start rounded-lg border border-neutral-200 px-3 py-2 text-[12px] font-medium text-neutral-600 transition-colors hover:border-[#007AFF]/30 hover:text-[#007AFF] disabled:cursor-not-allowed disabled:opacity-40 sm:self-center"
                  >
                    {historyLoadingId === item.id ? <Loader2 size={13} className="animate-spin" /> : <History size={13} />}
                    {historyLoadingId === item.id ? '读取中…' : '查看轨迹'}
                  </button>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-4 text-[12px] text-neutral-500">
              <span>共 {history.total} 次调用，第 {history.page} / {Math.max(1, history.totalPages)} 页</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => void loadHistory(historyPage - 1)} disabled={historyLoading || historyPage <= 1} className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 px-3 py-2 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"><ChevronLeft size={13} /> 上一页</button>
                <button type="button" onClick={() => void loadHistory(historyPage + 1)} disabled={historyLoading || historyPage >= history.totalPages} className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 px-3 py-2 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40">下一页 <ChevronRight size={13} /></button>
              </div>
            </div>
          </>
        ) : (
          <div className="py-8 text-center text-[13px] text-neutral-400">暂无历史调用记录，提交问题后会自动留痕。</div>
        )}
      </section>
    </div>
  )
}
