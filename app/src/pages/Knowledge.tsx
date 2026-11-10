import { useEffect, useRef, useState } from 'react'
import { BookMarked, Search, Loader2, Sparkles, RefreshCw, CircleAlert, FileText, History, X } from 'lucide-react'
import { Link } from 'react-router'
import { getCurrentUser } from '@/lib/auth'
import { diffLines, type DiffLine } from '@/lib/diffLines'
import { REG_CATEGORY_META, REG_CATEGORY_ORDER } from '@/components/badges'
import type { KnowledgeDocDetail, KnowledgeDocItem, KnowledgeDocVersionItem, PrelabelStats, Regulation } from '@/types'

// ─────────────────────────────────────────────────────────────
// 知识检索的资料检索、法规制度与文档管理视图。
// 页签、模型配置与 Agent 联动由 KnowledgeHub 统一承载。
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

interface ReindexJob {
  running: boolean
  total: number
  done: number
  docs: number
  error: string
  finishedAt: string | null
}

export type KnowledgeView = 'ask' | 'regs' | 'docs'

interface KnowledgeProps {
  tab: KnowledgeView
  onAnalyze: (question: string) => void
  configVersion: number
}

const KIND_META: Record<string, { label: string; cls: string }> = {
  issue: { label: '隐患案例', cls: 'bg-[#007AFF]/10 text-[#007AFF]' },
  bulletin: { label: '督查通报', cls: 'bg-[#FF9500]/12 text-[#B25000]' },
  annotation: { label: '参考标注', cls: 'bg-[#FF3B30]/10 text-[#D70015]' },
  manual: { label: '规程制度', cls: 'bg-[#34C759]/12 text-[#1F7A33]' },
  practice: { label: '好做法', cls: 'bg-[#34C759]/12 text-[#248A3D]' },
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

function fmtTime(iso: string) {
  return iso.slice(0, 16).replace('T', ' ')
}

export default function Knowledge({ tab, onAnalyze, configVersion }: KnowledgeProps) {
  const [status, setStatus] = useState<KnowledgeStatus | null>(null)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<AskResult | null>(null)
  const [error, setError] = useState('')
  const isAdmin = getCurrentUser()?.role === 'admin'

  // 重建索引（后台任务 + 进度轮询）
  const [job, setJob] = useState<ReindexJob | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  // AI 预标注人工改动率（改动率高说明 AI 口径与人工偏差大，可多设范例）
  const [prelabelStats, setPrelabelStats] = useState<PrelabelStats | null>(null)

  // ── 法规制度页签 ──
  const [regs, setRegs] = useState<Regulation[] | null>(null)
  const [regQ, setRegQ] = useState('')

  // ── 文档管理页签 ──
  const [docList, setDocList] = useState<KnowledgeDocItem[] | null>(null)
  const [docQ, setDocQ] = useState('')
  const [docDetail, setDocDetail] = useState<KnowledgeDocDetail | null>(null)
  const [draft, setDraft] = useState({ title: '', content: '', note: '' })
  const [docSaving, setDocSaving] = useState(false)
  const [docMsg, setDocMsg] = useState('')

  // ── 版本历史弹窗 ──
  const [verOpen, setVerOpen] = useState(false)
  const [versions, setVersions] = useState<KnowledgeDocVersionItem[]>([])
  /** 对比选择：'current' 或版本 id，最多 2 个 */
  const [compareSel, setCompareSel] = useState<string[]>([])
  const [diffView, setDiffView] = useState<{ leftLabel: string; rightLabel: string; lines: DiffLine[] } | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  const loadStatus = () => api<KnowledgeStatus>('/knowledge/status').then(setStatus).catch(() => setStatus(null))
  useEffect(() => {
    loadStatus()
    // 进入页面时若后台正在重建，接上进度轮询
    api<ReindexJob>('/knowledge/reindex/status').then((j) => {
      if (j.running) { setJob(j); startPolling() }
    }).catch(() => undefined)
    api<PrelabelStats>('/issues/prelabel/stats').then(setPrelabelStats).catch(() => setPrelabelStats(null))
    return () => { if (pollTimer.current) clearInterval(pollTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (configVersion > 0) void loadStatus()
  }, [configVersion])

  // 法规制度页签：首次进入加载，关键词停顿 300ms 后检索
  useEffect(() => {
    if (tab !== 'regs') return
    const timer = setTimeout(() => {
      const query = regQ.trim()
      api<Regulation[]>(`/regulations${query ? `?q=${encodeURIComponent(query)}` : ''}`)
        .then(setRegs)
        .catch(() => setRegs([]))
    }, regs === null ? 0 : 300)
    return () => clearTimeout(timer)
  }, [tab, regQ, regs === null]) // eslint-disable-line react-hooks/exhaustive-deps

  // 文档管理页签：加载文档列表
  const loadDocs = (keyword = '') => {
    const query = keyword.trim()
    return api<KnowledgeDocItem[]>(`/knowledge/docs${query ? `?q=${encodeURIComponent(query)}` : ''}`)
      .then(setDocList)
      .catch(() => setDocList([]))
  }
  useEffect(() => {
    if (tab !== 'docs') return
    const timer = setTimeout(() => { void loadDocs(docQ) }, docList === null ? 0 : 300)
    return () => clearTimeout(timer)
  }, [tab, docQ, docList === null]) // eslint-disable-line react-hooks/exhaustive-deps

  const startPolling = () => {
    if (pollTimer.current) clearInterval(pollTimer.current)
    pollTimer.current = setInterval(async () => {
      try {
        const j = await api<ReindexJob>('/knowledge/reindex/status')
        setJob(j)
        if (!j.running) {
          if (pollTimer.current) clearInterval(pollTimer.current)
          pollTimer.current = null
          loadStatus()
          if (!j.error) setTimeout(() => setJob(null), 4000) // 完成后停留 4 秒再收起
        }
      } catch { /* 网络抖动忽略，下轮再试 */ }
    }, 1000)
  }

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
    if (job?.running) return
    setError('')
    try {
      const j = await api<ReindexJob>('/knowledge/reindex', { method: 'POST' })
      setJob(j)
      startPolling()
    } catch {
      setError('重建索引启动失败')
    }
  }

  /** 打开文档编辑：拉详情（正文 = 切片拼接） */
  const openDoc = async (id: string) => {
    setDocMsg('')
    try {
      const d = await api<KnowledgeDocDetail>(`/knowledge/docs/${id}`)
      setDocDetail(d)
      setDraft({ title: d.title, content: d.content, note: '' })
    } catch {
      setError('文档加载失败')
    }
  }

  /** 保存编辑：后端先把旧内容快照为历史版本，再更新并重建索引 */
  const saveDoc = async () => {
    if (!docDetail || docSaving) return
    setDocSaving(true)
    setDocMsg('')
    try {
      const d = await api<KnowledgeDocDetail>(`/knowledge/docs/${docDetail.id}`, {
        method: 'PUT',
        body: JSON.stringify({ title: draft.title, content: draft.content, note: draft.note }),
      })
      setDocDetail(d)
      setDraft({ title: d.title, content: d.content, note: '' })
      setDocMsg('已保存（旧内容已存为历史版本）')
      loadStatus()
      void loadDocs(docQ)
      setTimeout(() => setDocMsg(''), 3000)
    } catch {
      setDocMsg('保存失败')
    } finally {
      setDocSaving(false)
    }
  }

  /** 打开版本历史弹窗 */
  const openVersions = async () => {
    if (!docDetail) return
    setVerOpen(true)
    setCompareSel([])
    setDiffView(null)
    try {
      setVersions(await api<KnowledgeDocVersionItem[]>(`/knowledge/docs/${docDetail.id}/versions`))
    } catch {
      setVersions([])
    }
  }

  /** 选择对比项（最多 2 个；选满后再点替换最早选的那个） */
  const toggleCompare = (key: string) => {
    setCompareSel((cur) => {
      if (cur.includes(key)) return cur.filter((k) => k !== key)
      return cur.length >= 2 ? [cur[1], key] : [...cur, key]
    })
  }

  /** 选满 2 项后生成 diff */
  useEffect(() => {
    if (compareSel.length !== 2 || !docDetail) {
      setDiffView(null)
      return
    }
    const run = async () => {
      setDiffLoading(true)
      try {
        // 解析两侧内容：current = 当前正文；版本 id = 该版本快照
        const contents = new Map<string, { label: string; content: string; order: number }>()
        for (const key of compareSel) {
          if (key === 'current') {
            contents.set(key, { label: '当前', content: docDetail.content, order: Number.MAX_SAFE_INTEGER })
          } else {
            const v = await api<KnowledgeDocVersionItem & { content: string }>(`/knowledge/docs/${docDetail.id}/versions/${key}`)
            contents.set(key, { label: `v${v.version} · ${fmtTime(v.createdAt)}`, content: v.content, order: v.version })
          }
        }
        const [a, b] = [...contents.values()].sort((x, y) => x.order - y.order)
        setDiffView({ leftLabel: a.label, rightLabel: b.label, lines: diffLines(a.content, b.content) })
      } catch {
        setDiffView(null)
      } finally {
        setDiffLoading(false)
      }
    }
    void run()
  }, [compareSel, docDetail])

  const docChanged = docDetail && (draft.title !== docDetail.title || draft.content !== docDetail.content)
  const reindexing = !!job?.running

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {tab === 'ask' && (
        <>
          {/* 知识索引状态与管理员维护入口 */}
          {status && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-neutral-100 bg-white p-4 text-[13px] text-neutral-600 shadow-sm">
              <span>文档 <b className="text-neutral-900">{status.docs}</b> 篇</span>
              <span>知识片段 <b className="text-neutral-900">{status.chunks}</b> 段</span>
              <span>检索模型{status.modelReady
                ? <span className="font-medium text-[#248A3D]">已就绪</span>
                : <span className="font-medium text-[#D70015]">未就绪</span>}
              </span>
              <span>智能整理{status.llm.configured
                ? <span className="font-medium text-[#248A3D]">已启用</span>
                : <span className="text-neutral-400">未启用，仅返回原文</span>}
              </span>
              {isAdmin && (
                <button
                  type="button"
                  onClick={reindex}
                  disabled={reindexing}
                  className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
                >
                  {reindexing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  {reindexing ? '重建中…' : '重建索引'}
                </button>
              )}
            </div>
          )}

          {/* 重建进度条 */}
          {job && (job.running || job.error || job.finishedAt) && (
            <div className="rounded-2xl border border-neutral-100 bg-white p-4 shadow-sm">
              {job.running ? (
                <>
                  <div className="mb-2 flex justify-between text-[12px] text-neutral-500">
                    <span>正在重建索引（{job.docs} 篇文档）…</span>
                    <span>{job.done} / {job.total || '…'}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
                    <div className="h-full bg-[#007AFF] transition-all duration-500" style={{ width: job.total ? `${Math.round((job.done / job.total) * 100)}%` : '8%' }} />
                  </div>
                </>
              ) : job.error ? (
                <div className="text-[13px] text-[#D70015]">重建失败：{job.error}</div>
              ) : (
                <div className="text-[13px] text-[#248A3D]">重建完成：{job.docs} 篇文档、{job.done} 个知识片段</div>
              )}
            </div>
          )}

          <form
            onSubmit={(event) => { event.preventDefault(); void ask() }}
            className="rounded-2xl border border-neutral-100 bg-white p-4 shadow-sm"
          >
            <label htmlFor="knowledge-search-input" className="text-[14px] font-medium text-neutral-800">查找知识原文</label>
            <p className="mt-1 text-[12px] leading-5 text-neutral-400">检索历史隐患、整改记录、督查通报与规程制度</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                id="knowledge-search-input"
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder="例如：配电箱没上锁有什么风险？以前出过类似问题吗？"
                className="min-h-11 min-w-0 flex-1 rounded-xl bg-neutral-50 px-4 py-3 text-[14px] outline-none focus:bg-neutral-100 focus:ring-2 focus:ring-[#007AFF]/20"
              />
              <button
                type="submit"
                disabled={loading || !q.trim() || reindexing}
                className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[#007AFF] px-5 py-3 text-[14px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                {loading ? '正在检索…' : '检索资料'}
              </button>
            </div>
          </form>

          {error && (
            <div className="rounded-xl bg-[#FF3B30]/8 px-4 py-3 text-[13px] text-[#D70015] flex items-center gap-2">
              <CircleAlert size={15} /> {error}
            </div>
          )}

          {result?.answer && (
            <div className="rounded-2xl border border-neutral-100 bg-white p-5 shadow-sm">
              <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-[#007AFF]">
                <Sparkles size={15} /> 资料智能整理
              </div>
              <p className="whitespace-pre-wrap text-[14px] leading-7 text-neutral-800">{result.answer}</p>
            </div>
          )}
          {result && !result.llmConfigured && (
            <div className="rounded-xl bg-neutral-50 px-4 py-3 text-[12px] leading-5 text-neutral-500">
              当前展示知识库原文。管理员启用模型配置后，可同时查看智能整理内容。
            </div>
          )}

          {/* 检索结果可带入 Agent，但由用户确认后再提交 */}
          {result && result.hits.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="text-[13px] font-medium text-neutral-500">相关资料（{result.hits.length}）</div>
                <button
                  type="button"
                  onClick={() => onAnalyze(q.trim())}
                  className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-full border border-[#007AFF]/20 px-3 py-1.5 text-[12px] font-medium text-[#007AFF] hover:bg-[#007AFF]/5"
                >
                  <Sparkles size={13} /> 交给 Agent 继续分析
                </button>
              </div>
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
        </>
      )}

      {/* ── 法规制度页签：按 5 类分组只读浏览 ── */}
      {tab === 'regs' && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-white p-2 shadow-sm border border-neutral-100 flex items-center gap-2">
            <Search size={16} className="ml-3 text-neutral-400" />
            <input
              value={regQ}
              onChange={(e) => setRegQ(e.target.value)}
              placeholder="搜索法规名称 / 条款 / 关键词…"
              className="flex-1 rounded-xl bg-neutral-50 px-4 py-2.5 text-[14px] outline-none focus:bg-neutral-100"
            />
          </div>
          {regs === null ? (
            <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-neutral-400 shadow-sm border border-neutral-100">
              <Loader2 size={16} className="animate-spin inline-block mr-2" />加载中…
            </div>
          ) : regs.length === 0 ? (
            <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-neutral-400 shadow-sm border border-neutral-100">
              没有匹配的法规条目
            </div>
          ) : (
            REG_CATEGORY_ORDER.map((cat) => {
              const items = regs.filter((r) => r.category === cat)
              if (items.length === 0) return null
              const meta = REG_CATEGORY_META[cat]
              return (
                <div key={cat} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium ${meta.cls}`}>{meta.label}</span>
                    <span className="text-[12px] text-neutral-400">{items.length} 部</span>
                  </div>
                  <div className="rounded-2xl bg-white shadow-sm border border-neutral-100 divide-y divide-neutral-100">
                    {items.map((r) => (
                      <div key={r.id} className="p-4">
                        <div className="flex items-center gap-2">
                          <BookMarked size={15} className="shrink-0 text-[#007AFF]" />
                          <span className="text-[14px] font-medium text-neutral-900">{r.title}</span>
                          {r.articleNo && <span className="text-[12px] text-neutral-400">{r.articleNo}</span>}
                        </div>
                        {r.summary && <p className="mt-1 pl-6 text-[13px] leading-6 text-neutral-500">{r.summary}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}

      {/* ── 文档管理页签：文档列表 + 编辑 + 版本历史 ── */}
      {tab === 'docs' && (
        <div className="space-y-4">
          {prelabelStats && prelabelStats.total > 0 && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-neutral-100 bg-white p-4 text-[13px] text-neutral-600 shadow-sm">
              <span className="font-medium text-neutral-800">预标注质量</span>
              <span>已预标注 <b className="text-neutral-900">{prelabelStats.total}</b> 条</span>
              <span>人工改判 <b className="text-neutral-900">{prelabelStats.changed}</b> 条</span>
              <span>改动率 <b className={prelabelStats.rate >= 0.3 ? 'text-[#B25000]' : 'text-[#248A3D]'}>{(prelabelStats.rate * 100).toFixed(0)}%</b></span>
              <span className="text-[12px] leading-5 text-neutral-400">改动率较高时，可在问题库将已复核条目设为预标注范例</span>
            </div>
          )}
          {!docDetail ? (
            <>
              <div className="rounded-2xl bg-white p-2 shadow-sm border border-neutral-100 flex items-center gap-2">
                <Search size={16} className="ml-3 text-neutral-400" />
                <input
                  value={docQ}
                  onChange={(e) => setDocQ(e.target.value)}
                  placeholder="搜索文档标题…"
                  className="flex-1 rounded-xl bg-neutral-50 px-4 py-2.5 text-[14px] outline-none focus:bg-neutral-100"
                />
              </div>
              {docList === null ? (
                <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-neutral-400 shadow-sm border border-neutral-100">
                  <Loader2 size={16} className="animate-spin inline-block mr-2" />加载中…
                </div>
              ) : docList.length === 0 ? (
                <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-neutral-400 shadow-sm border border-neutral-100">
                  没有文档。请先在「资料检索」页由管理员「重建索引」。
                </div>
              ) : (
                <div className="rounded-2xl bg-white shadow-sm border border-neutral-100 divide-y divide-neutral-100">
                  {docList.map((d) => {
                    const meta = KIND_META[d.kind] ?? { label: d.kind, cls: 'bg-neutral-100 text-neutral-500' }
                    return (
                      <button key={d.id} onClick={() => openDoc(d.id)} className="w-full text-left p-4 hover:bg-neutral-50 transition-colors">
                        <div className="flex items-center gap-2">
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>
                          <span className="flex-1 min-w-0 truncate text-[14px] font-medium text-neutral-900">{d.title}</span>
                          {d.versions > 0 && (
                            <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-neutral-400">
                              <History size={12} /> {d.versions} 个版本
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-[12px] text-neutral-400 flex gap-3">
                          <span>{d.source || '—'}</span>
                          <span>{d.chunks} 段</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            /* 文档编辑区 */
            <div className="rounded-2xl bg-white p-5 shadow-sm border border-neutral-100 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText size={16} className="shrink-0 text-[#007AFF]" />
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${(KIND_META[docDetail.kind] ?? { cls: 'bg-neutral-100 text-neutral-500' }).cls}`}>
                    {(KIND_META[docDetail.kind] ?? { label: docDetail.kind }).label}
                  </span>
                  <span className="truncate text-[12px] text-neutral-400">{docDetail.source}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={openVersions}
                    className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50"
                  >
                    <History size={13} /> 历史版本
                  </button>
                  <button
                    onClick={() => { setDocDetail(null); setDocMsg(''); void loadDocs(docQ) }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50"
                  >
                    <X size={13} /> 返回列表
                  </button>
                </div>
              </div>
              <div>
                <label className="text-[12px] text-neutral-500 block mb-1">标题</label>
                <input
                  value={draft.title}
                  onChange={(e) => setDraft((f) => ({ ...f, title: e.target.value }))}
                  className="w-full rounded-xl bg-neutral-50 px-3.5 py-2.5 text-[14px] font-medium outline-none focus:bg-neutral-100"
                />
              </div>
              <div>
                <label className="text-[12px] text-neutral-500 block mb-1">正文</label>
                <textarea
                  value={draft.content}
                  onChange={(e) => setDraft((f) => ({ ...f, content: e.target.value }))}
                  className="w-full rounded-xl bg-neutral-50 px-3.5 py-2.5 text-[13px] leading-6 outline-none focus:bg-neutral-100 min-h-64 font-mono"
                />
              </div>
              <div>
                <label className="text-[12px] text-neutral-500 block mb-1">修订说明（本次改动一句话，写入历史版本）</label>
                <input
                  value={draft.note}
                  onChange={(e) => setDraft((f) => ({ ...f, note: e.target.value }))}
                  placeholder="例如：更新检查频次要求"
                  className="w-full rounded-xl bg-neutral-50 px-3.5 py-2.5 text-[13px] outline-none focus:bg-neutral-100"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={saveDoc}
                  disabled={docSaving || !docChanged || !draft.title.trim()}
                  className="rounded-xl bg-[#007AFF] px-5 py-2.5 text-[13px] font-medium text-white disabled:opacity-40"
                >
                  {docSaving ? '保存中…' : '保存'}
                </button>
                {docChanged && <span className="text-[12px] text-neutral-400">保存时会把当前内容存为一个历史版本</span>}
                {docMsg && <span className={`text-[12px] ${docMsg.startsWith('已保存') ? 'text-[#34C759]' : 'text-[#D70015]'}`}>{docMsg}</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 版本历史弹窗：版本列表 + 两两对比（逐行 diff） ── */}
      {verOpen && docDetail && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={() => setVerOpen(false)}>
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-[17px] font-semibold flex items-center gap-2">
                  <History size={17} className="text-[#007AFF]" /> 历史版本
                </h2>
                <p className="text-[12px] text-neutral-400 mt-0.5">勾选任意两项（含「当前」）查看逐行对比</p>
              </div>
              <button onClick={() => setVerOpen(false)} className="p-1.5 text-neutral-400 hover:text-neutral-700 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-100">
              {/* 当前版本（可参与对比） */}
              <li className="flex items-center gap-3 px-4 py-2.5">
                <input
                  type="checkbox"
                  className="accent-[#007AFF]"
                  checked={compareSel.includes('current')}
                  onChange={() => toggleCompare('current')}
                />
                <span className="text-[13px] font-medium text-neutral-900">当前</span>
                <span className="text-[12px] text-neutral-400 truncate">{docDetail.title}</span>
              </li>
              {versions.length === 0 && (
                <li className="px-4 py-6 text-center text-[13px] text-neutral-400">还没有历史版本，编辑保存一次后这里会出现旧版本快照</li>
              )}
              {versions.map((v) => (
                <li key={v.id} className="flex items-center gap-3 px-4 py-2.5">
                  <input
                    type="checkbox"
                    className="accent-[#007AFF]"
                    checked={compareSel.includes(v.id)}
                    onChange={() => toggleCompare(v.id)}
                  />
                  <span className="shrink-0 rounded-full bg-[#007AFF]/10 text-[#007AFF] px-2 py-0.5 text-[11px] font-medium">v{v.version}</span>
                  <span className="shrink-0 text-[12px] text-neutral-400">{fmtTime(v.createdAt)}</span>
                  <span className="flex-1 min-w-0 truncate text-[13px] text-neutral-700">{v.note || v.title}</span>
                </li>
              ))}
            </ul>

            {/* diff 视图 */}
            {compareSel.length === 2 && (
              <div className="space-y-2">
                {diffLoading && <p className="text-[13px] text-neutral-400 flex items-center gap-2"><Loader2 size={14} className="animate-spin" />正在对比…</p>}
                {diffView && (
                  <>
                    <div className="flex items-center gap-2 text-[12px] text-neutral-500">
                      <span className="rounded bg-[#FF3B30]/10 text-[#D70015] px-2 py-0.5">− {diffView.leftLabel}</span>
                      <span>→</span>
                      <span className="rounded bg-[#34C759]/12 text-[#248A3D] px-2 py-0.5">+ {diffView.rightLabel}</span>
                    </div>
                    <div className="rounded-xl border border-neutral-100 overflow-hidden text-[12px] font-mono leading-5">
                      {diffView.lines.every((l) => l.type === 'same') && (
                        <p className="px-4 py-6 text-center text-neutral-400 font-sans">两项内容完全一致</p>
                      )}
                      {diffView.lines.map((l, i) =>
                        l.type === 'same' ? (
                          <div key={i} className="px-3 py-0.5 text-neutral-500 whitespace-pre-wrap break-all">{'  '}{l.text}</div>
                        ) : l.type === 'del' ? (
                          <div key={i} className="px-3 py-0.5 bg-[#FF3B30]/10 text-[#D70015] whitespace-pre-wrap break-all">− {l.text}</div>
                        ) : (
                          <div key={i} className="px-3 py-0.5 bg-[#34C759]/12 text-[#1F7A33] whitespace-pre-wrap break-all">+ {l.text}</div>
                        ),
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
