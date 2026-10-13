import { useEffect, useState } from 'react'
import { BookOpen, Search, Loader2, Sparkles, RefreshCw, CircleAlert } from 'lucide-react'
import { Link } from 'react-router'
import { getCurrentUser } from '@/lib/auth'

// ─────────────────────────────────────────────────────────────
// 知识库：语义检索车间历史隐患、参考标注与督查通报原文
// AI 问答预留给 DeepSeek（后端配置 LLM_API_KEY 后自动启用）
// ─────────────────────────────────────────────────────────────

interface KnowledgeStatus {
  modelReady: boolean
  llm: { configured: boolean; model: string }
  docs: number
  chunks: number
  byKind: Record<string, number>
}

interface Hit {
  docId: string
  kind: string
  title: string
  content: string
  score: number
}

interface AskResult {
  answer: string | null
  hits: Hit[]
  llmConfigured: boolean
  model: string
}

const KIND_META: Record<string, { label: string; cls: string }> = {
  issue: { label: '隐患案例', cls: 'bg-[#007AFF]/10 text-[#007AFF]' },
  bulletin: { label: '督查通报', cls: 'bg-[#FF9500]/12 text-[#B25000]' },
  annotation: { label: '参考标注', cls: 'bg-[#FF3B30]/10 text-[#D70015]' },
  manual: { label: '规程制度', cls: 'bg-[#34C759]/12 text-[#1F7A33]' },
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('wsms-token')
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json() as Promise<T>
}

export default function Knowledge() {
  const [status, setStatus] = useState<KnowledgeStatus | null>(null)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<AskResult | null>(null)
  const [reindexing, setReindexing] = useState(false)
  const [error, setError] = useState('')
  const isAdmin = getCurrentUser()?.role === 'admin'

  const loadStatus = () => api<KnowledgeStatus>('/knowledge/status').then(setStatus).catch(() => setStatus(null))
  useEffect(() => { loadStatus() }, [])

  const ask = async () => {
    if (!q.trim() || loading) return
    setLoading(true)
    setError('')
    try {
      setResult(await api<AskResult>('/knowledge/ask', { method: 'POST', body: JSON.stringify({ question: q.trim() }) }))
    } catch {
      setError('检索失败，请确认后端与嵌入模型已就绪')
    } finally {
      setLoading(false)
    }
  }

  const reindex = async () => {
    if (reindexing) return
    setReindexing(true)
    try {
      await api('/knowledge/reindex', { method: 'POST' })
      await loadStatus()
    } catch {
      setError('重建索引失败')
    } finally {
      setReindexing(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 space-y-5">
      {/* 页头 */}
      <div>
        <h1 className="text-[22px] font-bold text-neutral-900 flex items-center gap-2">
          <BookOpen size={22} className="text-[#007AFF]" /> 车间知识库
        </h1>
        <p className="mt-1 text-[13px] text-neutral-500">用大白话提问，系统从历年隐患、整改记录和督查通报里找答案</p>
      </div>

      {/* 状态卡 */}
      {status && (
        <div className="rounded-2xl bg-white p-4 shadow-sm border border-neutral-100 text-[13px] text-neutral-600 flex flex-wrap items-center gap-x-5 gap-y-2">
          <span>文档 <b className="text-neutral-900">{status.docs}</b> 篇</span>
          <span>切片 <b className="text-neutral-900">{status.chunks}</b> 段</span>
          <span>
            嵌入模型{status.modelReady
              ? <span className="text-[#34C759] font-medium">已就绪</span>
              : <span className="text-[#FF3B30] font-medium">未就绪</span>}
          </span>
          <span>
            AI 回答{status.llm.configured
              ? <span className="text-[#34C759] font-medium">已启用（{status.llm.model}）</span>
              : <span className="text-neutral-400">未配置 Key，仅检索</span>}
          </span>
          {isAdmin && (
            <button
              onClick={reindex}
              disabled={reindexing}
              className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
            >
              {reindexing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {reindexing ? '重建中…' : '重建索引'}
            </button>
          )}
        </div>
      )}

      {/* 提问框 */}
      <div className="rounded-2xl bg-white p-2 shadow-sm border border-neutral-100 flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder="例如：配电箱没上锁有什么风险？以前出过类似问题吗？"
          className="flex-1 rounded-xl bg-neutral-50 px-4 py-3 text-[14px] outline-none focus:bg-neutral-100"
        />
        <button
          onClick={ask}
          disabled={loading || !q.trim()}
          className="inline-flex items-center gap-1.5 rounded-xl bg-[#007AFF] px-5 py-3 text-[14px] font-medium text-white disabled:opacity-40"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
          提问
        </button>
      </div>

      {error && (
        <div className="rounded-xl bg-[#FF3B30]/8 px-4 py-3 text-[13px] text-[#D70015] flex items-center gap-2">
          <CircleAlert size={15} /> {error}
        </div>
      )}

      {/* AI 回答 */}
      {result?.answer && (
        <div className="rounded-2xl bg-white p-5 shadow-sm border border-neutral-100">
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-[#007AFF] mb-2">
            <Sparkles size={15} /> AI 回答（{result.model}）
          </div>
          <p className="whitespace-pre-wrap text-[14px] leading-7 text-neutral-800">{result.answer}</p>
        </div>
      )}
      {result && !result.llmConfigured && (
        <div className="rounded-xl bg-neutral-50 px-4 py-3 text-[12px] text-neutral-500">
          以下为知识库原文检索结果。配置 DeepSeek API Key 后，这里会直接给出整理好的回答。
        </div>
      )}

      {/* 检索结果 */}
      {result && result.hits.length > 0 && (
        <div className="space-y-3">
          <div className="text-[13px] font-medium text-neutral-500">相关资料（{result.hits.length}）</div>
          {result.hits.map((h, i) => {
            const meta = KIND_META[h.kind] ?? { label: h.kind, cls: 'bg-neutral-100 text-neutral-500' }
            return (
              <div key={i} className="rounded-2xl bg-white p-4 shadow-sm border border-neutral-100">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>
                  <span className="text-[14px] font-medium text-neutral-900 truncate">{h.title}</span>
                  <span className="ml-auto shrink-0 text-[12px] text-neutral-400">{(h.score * 100).toFixed(0)}%</span>
                </div>
                <p className="text-[13px] leading-6 text-neutral-600 whitespace-pre-wrap line-clamp-4">{h.content}</p>
                {h.kind === 'issue' && (
                  <Link to="/issues" className="mt-1 inline-block text-[12px] text-[#007AFF]">到问题库查看 →</Link>
                )}
              </div>
            )
          })}
        </div>
      )}
      {result && result.hits.length === 0 && (
        <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-neutral-400 shadow-sm border border-neutral-100">
          知识库里没有找到相关内容。换个说法试试，或先由管理员「重建索引」。
        </div>
      )}
    </div>
  )
}
