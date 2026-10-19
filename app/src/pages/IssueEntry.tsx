import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { FileUp, Loader2, CheckSquare, Square, ClipboardCheck, ImagePlus, X, ChevronDown, ChevronRight } from 'lucide-react'
import { uploadPhotos, useStore } from '@/lib/store'
import { isManagedWorkshop, TEAMS, countGridOwners, withSubTags } from '@/lib/config'
import { detectSource, parseFileOffthread, type SkippedPage } from '@/lib/import/parsers'
import { matchReview } from '@/lib/import/matchReview'
import { RISK_LABEL, RiskBadge, StatusBadge, CAUSE_TYPE_LABEL, COUNTERMEASURE_LABEL } from '@/components/badges'
import type { CauseType, CountermeasureLevel, IssueDraft, IssueSource, ReviewDraft, RiskLevel } from '@/types'

// ── 录入联动：与知识库语义比对，提示相似既有隐患 ──
interface SimilarCase { issueId: string; title: string; score: number; snippet: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('wsms-token')
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

export default function IssueEntry() {
  const { tags, issues, addIssue, addIssues, updateIssue, ensureTag } = useStore()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'manual' | 'file'>('manual')

  // ── 手动录入 ──
  const [form, setForm] = useState({
    title: '', description: '', locationId: '', categoryId: '',
    riskLevel: 'general' as RiskLevel, assignee: '', deadline: '',
    team: '', gridOperator: '', gridOwner: '', systemOwner: '', systemCause: '',
    causeType: '' as '' | CauseType, countermeasureLevel: '' as '' | CountermeasureLevel, countermeasureReason: '',
  })
  /** 根因校验：系统原因选「管理」对策时必须说明为什么机制和技术做不到 */
  const reasonMissing = form.causeType === 'system' && form.countermeasureLevel === 'management' && !form.countermeasureReason.trim()
  /** 待上传的现场照片（本地 File，提交时统一上传） */
  const [photoFiles, setPhotoFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const photoRef = useRef<HTMLInputElement>(null)
  const categories = tags.filter((t) => t.group === 'category')
  const locations = tags.filter((t) => t.group === 'location')
  /** 网格责任人重复统计：录入时同名即时提醒 */
  const gridOwnerCounts = countGridOwners(issues)

  // ── 录入联动：标题/描述停顿后检索相似案例，避免同类问题重复发生 ──
  const [similar, setSimilar] = useState<SimilarCase[]>([])
  const [similarLoading, setSimilarLoading] = useState(false)
  const [similarOpen, setSimilarOpen] = useState<string | null>(null)
  const similarSeq = useRef(0)

  useEffect(() => {
    const q = `${form.title}\n${form.description}`.trim()
    if (tab !== 'manual' || q.replace(/\s+/g, '').length < 6) {
      setSimilar([])
      return
    }
    const seq = ++similarSeq.current
    const timer = setTimeout(async () => {
      setSimilarLoading(true)
      try {
        const res = await api<{ ready: boolean; items: SimilarCase[] }>('/knowledge/similar', {
          method: 'POST',
          body: JSON.stringify({ text: q, limit: 4 }),
        })
        if (seq !== similarSeq.current) return
        // 相似度不足的不提示，避免噪音（后端为 0.65×向量+0.35×词面混合分）
        setSimilar(res.ready ? res.items.filter((i) => i.score >= 0.35) : [])
      } catch {
        if (seq === similarSeq.current) setSimilar([])
      } finally {
        if (seq === similarSeq.current) setSimilarLoading(false)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [form.title, form.description, tab])

  const submitManual = async () => {
    if (!form.title.trim() || reasonMissing || submitting) return
    setSubmitting(true)
    try {
      const photos = await uploadPhotos(photoFiles)
      const locationName = tags.find((t) => t.id === form.locationId)?.name
      addIssue({
        title: form.title.trim(),
        description: form.description.trim(),
        locationId: form.locationId || undefined,
        categoryId: form.categoryId || undefined,
        tagIds: [],
        riskLevel: form.riskLevel,
        status: 'pending',
        // 未选区域默认按成品车间管理；选了其他车间则仅参考
        scope: !form.locationId || isManagedWorkshop(locationName) ? 'managed' : 'reference',
        source: 'manual',
        reporter: '当前用户',
        assignee: form.assignee || undefined,
        team: form.team || undefined,
        gridOperator: form.gridOperator.trim() || undefined,
        gridOwner: form.gridOwner.trim() || undefined,
        systemOwner: form.systemOwner.trim() || undefined,
        systemCause: form.systemCause.trim() || undefined,
        causeType: form.causeType || undefined,
        countermeasureLevel: form.causeType === 'system' && form.countermeasureLevel ? form.countermeasureLevel : undefined,
        countermeasureReason: form.countermeasureReason.trim() || undefined,
        foundAt: new Date().toISOString(),
        deadline: form.deadline ? new Date(form.deadline).toISOString() : undefined,
        photos,
        recheckIntervalDays: 7,
        recheckRequired: 3,
        rechecks: [],
        stage: 'rechecking',
        // 手动录入即人工复核
        reviewed: true,
      })
      navigate('/issues')
    } finally {
      setSubmitting(false)
    }
  }

  // ── 文件导入（暂存区模式，支持批量多文件） ──
  const fileRef = useRef<HTMLInputElement>(null)
  const [parsing, setParsing] = useState(false)
  const [parseStage, setParseStage] = useState('')
  const [importing, setImporting] = useState(false)
  /** 本次批量解析的文件清单（名称 + 类型） */
  const [sourceFiles, setSourceFiles] = useState<Array<{ name: string; source: IssueSource }>>([])
  const [drafts, setDrafts] = useState<IssueDraft[]>([])
  const [reviews, setReviews] = useState<ReviewDraft[]>([])
  const [skipped, setSkipped] = useState<Array<SkippedPage & { fileName?: string }>>([])
  const [parseError, setParseError] = useState('')
  /** 导入查重：每条草稿与库中既有隐患的疑似重复命中（按草稿 key） */
  const [dupByKey, setDupByKey] = useState<Record<string, SimilarCase[]>>({})
  const [dupOpen, setDupOpen] = useState<string | null>(null)

  /** 按风险等级的默认整改期限（天）：即知即改当天 */
  const DEADLINE_DAYS: Record<RiskLevel, number> = { critical: 3, general: 15, immediate: 0 }

  /** 批量解析：逐个文件在 Worker 后台解析，结果合并进同一暂存区（草稿 key 加文件名前缀防冲突） */
  const onPickFiles = async (files: File[]) => {
    const usable = files.filter((f) => detectSource(f.name))
    if (!usable.length) return
    setParsing(true)
    setParseStage('读取文件中…')
    setParseError('')
    setDrafts([])
    setReviews([])
    setSkipped([])
    setSourceFiles([])
    setDupByKey({})
    setDupOpen(null)
    try {
      const allDrafts: IssueDraft[] = []
      const allReviews: ReviewDraft[] = []
      const allSkipped: Array<SkippedPage & { fileName?: string }> = []
      const filesMeta: Array<{ name: string; source: IssueSource }> = []
      for (let i = 0; i < usable.length; i++) {
        const file = usable[i]
        const source = detectSource(file.name)!
        // 解析在 Web Worker 后台线程执行：大文件解析期间页面不卡死、进度实时可见
        const { drafts: parsed, reviews: parsedReviews, skipped: parsedSkipped } = await parseFileOffthread(
          file,
          (done, total) => setParseStage(`第 ${i + 1}/${usable.length} 个文件：识别页面 ${done}/${total}…`),
        )
        filesMeta.push({ name: file.name, source })
        allDrafts.push(...parsed.map((d) => ({ ...d, key: `${file.name}#${d.key}`, fileName: file.name })))
        allReviews.push(...parsedReviews.map((r) => ({ ...r, key: `${file.name}#${r.key}`, fileName: file.name })))
        allSkipped.push(...parsedSkipped.map((s) => ({ ...s, fileName: file.name })))
      }
      // 自动建档：猜测的车间/类型名与标签库匹配，没有则幂等创建后关联
      const withTags = await Promise.all(
        allDrafts.map(async (d) => ({
          ...d,
          categoryId: d.categoryGuess
            ? (tags.find((t) => t.group === 'category' && t.name === d.categoryGuess)?.id
              ?? (await ensureTag(d.categoryGuess, 'category'))?.id)
            : undefined,
          locationId: d.locationGuess
            ? (tags.find((t) => t.group === 'location' && t.name === d.locationGuess)?.id
              ?? (await ensureTag(d.locationGuess, 'location'))?.id)
            : undefined,
        })),
      )
      // 复查核销：在库中未闭环隐患里模糊匹配对应项
      const openIssues = issues.filter((i) => i.status !== 'closed')
      const withMatch = allReviews.map((r) => {
        const m = matchReview(r, openIssues, tags)
        return { ...r, matchedIssueId: m?.issueId, matchedIssueTitle: m?.issueTitle }
      })
      setSourceFiles(filesMeta)
      setDrafts(withTags)
      setReviews(withMatch)
      setSkipped(allSkipped)
      // 导入查重：草稿全部入暂存区后，批量比对库中既有隐患，疑似重复的标记出来（不阻断导入，后台完成）
      api<{ ready: boolean; results: SimilarCase[][] }>('/knowledge/similar-batch', {
        method: 'POST',
        body: JSON.stringify({ texts: withTags.map((d) => `${d.title}\n${d.description}`), limit: 2 }),
      })
        .then((res) => {
          if (!res.ready) return
          const map: Record<string, SimilarCase[]> = {}
          withTags.forEach((d, i) => {
            const hits = (res.results[i] ?? []).filter((x) => x.score >= 0.35)
            if (hits.length) map[d.key] = hits
          })
          setDupByKey(map)
        })
        .catch(() => {})
    } catch (e) {
      setParseError(e instanceof Error ? e.message : '解析失败')
    } finally {
      setParsing(false)
    }
  }

  const confirmImport = async () => {
    if (!sourceFiles.length || importing) return
    const accepted = drafts.filter((d) => d.accepted)
    const acceptedReviews = reviews.filter((r) => r.accepted && r.matchedIssueId)
    if (!accepted.length && !acceptedReviews.length) return
    // 文件名 → 解析类型映射（批量导入时各文件类型可能不同）
    const sourceOf = (name?: string) => sourceFiles.find((f) => f.name === name)?.source ?? 'pptx'
    setImporting(true)
    try {
      if (accepted.length) {
        const items = await Promise.all(
          accepted.map(async (d) => {
            const foundAt = d.foundAtGuess ?? new Date().toISOString()
            const managed = isManagedWorkshop(d.locationGuess)
            // 先上传该页提取的现场照片，再把路径随隐患入库
            const photos = d.photos?.length ? await uploadPhotos(d.photos.slice(0, 9)) : []
            return {
              title: d.title.trim() || '未命名隐患',
              description: d.description,
              categoryId: d.categoryId,
              locationId: d.locationId,
              tagIds: [],
              riskLevel: d.riskLevel,
              status: 'pending' as const,
              scope: managed ? ('managed' as const) : ('reference' as const),
              source: sourceOf(d.fileName),
              sourceFile: d.fileName,
              reporter: '当前用户',
              foundAt,
              photos,
              recheckIntervalDays: 7,
              recheckRequired: 3,
              rechecks: [],
              stage: 'rechecking' as const,
              // AI 批量识别入库：标记为人工未复核，复核后改 true
              reviewed: false,
              // 参考件不设整改期限，不进入闭环与提醒
              deadline: managed
                ? new Date(new Date(foundAt).getTime() + DEADLINE_DAYS[d.riskLevel] * 86_400_000).toISOString()
                : undefined,
            }
          }),
        )
        addIssues(items)
      }
      // 复查核销：闭环命中的隐患，整改记录注明核销依据；整改后照片一并追加
      for (const r of acceptedReviews) {
        const target = issues.find((i) => i.id === r.matchedIssueId)
        const added = r.photos?.length ? await uploadPhotos(r.photos.slice(0, 9)) : []
        updateIssue(r.matchedIssueId!, {
          status: 'closed',
          closedAt: r.closedAtGuess ?? new Date().toISOString(),
          fixNote: `复查核销：据《${r.fileName ?? sourceFiles[0]?.name}》复查页，${r.conclusion}`,
          photos: [...(target?.photos ?? []), ...added].slice(0, 9),
        })
      }
      setDrafts([])
      setReviews([])
      setSkipped([])
      setSourceFiles([])
      setDupByKey({})
      setDupOpen(null)
      navigate('/issues')
    } catch (e) {
      // 照片上传/入库失败要让用户看见原因，不能默默卡死
      setParseError(e instanceof Error ? e.message : '导入失败，请重试')
    } finally {
      setImporting(false)
    }
  }

  const inputCls = 'w-full px-3.5 py-2.5 rounded-xl bg-neutral-100/80 text-[14px] outline-none focus:ring-2 ring-[#007AFF]/30 transition-shadow'

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">问题录入</h1>
        <p className="text-sm text-neutral-500 mt-1">手动登记隐患，或从 PPT / Word / Excel 批量导入</p>
      </header>

      {/* 页签 */}
      <div className="flex gap-1 bg-neutral-200/60 p-1 rounded-xl w-fit">
        {([['manual', '手动录入'], ['file', '文件导入']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-1.5 rounded-lg text-[14px] transition-colors ${tab === key ? 'bg-white shadow-sm font-medium' : 'text-neutral-500'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'manual' ? (
        <div className="space-y-4">
          {/* 基本信息 */}
          <section className="bg-white rounded-2xl p-6 shadow-sm space-y-5">
            <h2 className="text-[13px] font-semibold text-neutral-400 tracking-wide">基本信息</h2>
            <div>
              <label className="text-[13px] text-neutral-500 block mb-1.5">隐患标题 *</label>
              <input
                className={inputCls}
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="例如：配电箱箱门未关闭"
              />
            </div>
            <div>
              <label className="text-[13px] text-neutral-500 block mb-1.5">问题描述</label>
              <textarea
                className={`${inputCls} min-h-28`}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="位置、现状、风险说明…"
              />
            </div>
          </section>

          {/* 相似案例：知识库语义比对，点击展开详情 */}
          {(similar.length > 0 || similarLoading) && (
            <section className="bg-white rounded-2xl p-6 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-[13px] font-semibold text-neutral-400 tracking-wide">
                  {similar.length > 0 ? `相似案例（${similar.length}）` : '正在比对既有隐患…'}
                </h2>
                {similarLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-neutral-400" />}
              </div>
              <ul className="space-y-2">
                {similar.map((s) => {
                  const issue = issues.find((i) => i.id === s.issueId)
                  const open = similarOpen === s.issueId
                  return (
                    <li key={s.issueId} className="rounded-xl bg-neutral-50 border border-neutral-100">
                      <button
                        onClick={() => setSimilarOpen(open ? null : s.issueId)}
                        className="w-full text-left px-3.5 py-2.5"
                      >
                        <div className="flex items-center gap-2">
                          {open ? <ChevronDown className="w-3.5 h-3.5 text-neutral-400 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-neutral-400 shrink-0" />}
                          <span className="text-[14px] font-medium truncate flex-1">{s.title}</span>
                          <span className="text-[11px] text-neutral-400 shrink-0">相似度 {Math.round(s.score * 100)}%</span>
                        </div>
                        <div className="flex gap-1.5 mt-1.5 flex-wrap pl-5">
                          {issue && <StatusBadge status={issue.status} />}
                          {issue && <RiskBadge level={issue.riskLevel} />}
                          {issue?.categoryId && (
                            <span className="px-2 py-0.5 rounded-md text-[12px] font-medium bg-neutral-500/10 text-neutral-500">
                              {tags.find((t) => t.id === issue.categoryId)?.name ?? ''}
                            </span>
                          )}
                          {issue && <span className="text-[11px] text-neutral-400 self-center">{issue.foundAt.slice(0, 10)}</span>}
                        </div>
                      </button>
                      {open && issue && (
                        <div className="mx-3.5 mb-3 px-3 py-2.5 rounded-lg bg-white border border-neutral-100 text-[12px] text-neutral-500 space-y-1.5">
                          {issue.description && <p>{issue.description}</p>}
                          {issue.fixNote && <p className="text-[#248A3D]">整改措施：{issue.fixNote}</p>}
                          <p className="text-neutral-400">
                            {issue.scope === 'managed' ? '成品车间 · 纳入闭环' : '其他车间 · 仅参考'}
                            {issue.sourceFile ? ` · 来源：${issue.sourceFile}` : ''}
                          </p>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {/* 分类与等级 */}
          <section className="bg-white rounded-2xl p-6 shadow-sm space-y-5">
            <h2 className="text-[13px] font-semibold text-neutral-400 tracking-wide">分类与等级</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-[13px] text-neutral-500 block mb-1.5">隐患类型</label>
                <select className={inputCls} value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                  <option value="">未分类</option>
                  {withSubTags(categories).map(({ tag, depth }) => (
                    <option key={tag.id} value={tag.id}>{depth ? `${categories.find((p) => p.id === tag.parentId)?.name}-${tag.name}` : tag.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[13px] text-neutral-500 block mb-1.5">所在区域</label>
                <select className={inputCls} value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
                  <option value="">成品车间（默认）</option>
                  {locations.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-[13px] text-neutral-500 block mb-1.5">风险等级</label>
              <div className="flex gap-1 bg-neutral-200/60 p-1 rounded-xl w-fit">
                {([
                  ['immediate', '#007AFF'],
                  ['general', '#34C759'],
                  ['critical', '#FF3B30'],
                ] as const).map(([r, c]) => (
                  <button
                    key={r}
                    onClick={() => setForm({ ...form, riskLevel: r })}
                    className="px-5 py-1.5 rounded-lg text-[14px] transition-all"
                    style={
                      form.riskLevel === r
                        ? { backgroundColor: 'white', color: c, fontWeight: 600, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }
                        : { color: '#737373' }
                    }
                  >
                    {RISK_LABEL[r]}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* 期限与责任人 */}
          <section className="bg-white rounded-2xl p-6 shadow-sm space-y-5">
            <h2 className="text-[13px] font-semibold text-neutral-400 tracking-wide">整改安排</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-[13px] text-neutral-500 block mb-1.5">整改期限</label>
                <input type="date" className={inputCls} value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
              </div>
              <div>
                <label className="text-[13px] text-neutral-500 block mb-1.5">整改责任人</label>
                <input className={inputCls} value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} placeholder="选填" />
              </div>
            </div>
          </section>

          {/* 责任落实 */}
          <section className="bg-white rounded-2xl p-6 shadow-sm space-y-5">
            <h2 className="text-[13px] font-semibold text-neutral-400 tracking-wide">责任落实（选填）</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-[13px] text-neutral-500 block mb-1.5">责任班组</label>
                <select className={inputCls} value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })}>
                  <option value="">未指定</option>
                  {TEAMS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[13px] text-neutral-500 block mb-1.5">网格主操手</label>
                <input className={inputCls} value={form.gridOperator} onChange={(e) => setForm({ ...form, gridOperator: e.target.value })} />
              </div>
              <div>
                <label className="text-[13px] text-neutral-500 block mb-1.5">网格责任人</label>
                <input className={inputCls} value={form.gridOwner} onChange={(e) => setForm({ ...form, gridOwner: e.target.value })} />
                {form.gridOwner.trim() && (gridOwnerCounts.get(form.gridOwner.trim()) ?? 0) >= 1 && (
                  <p className="text-[12px] text-[#D70015] mt-1.5">
                    该责任人已在 {gridOwnerCounts.get(form.gridOwner.trim())} 条成品车间隐患中出现
                    {(gridOwnerCounts.get(form.gridOwner.trim()) ?? 0) >= 2
                      ? '，本条登记后将达 3 次以上，升级为严重提醒（加倍考核）'
                      : '，本条登记后将触发重复提醒'}
                  </p>
                )}
              </div>
              <div>
                <label className="text-[13px] text-neutral-500 block mb-1.5">系统责任人</label>
                <input className={inputCls} value={form.systemOwner} onChange={(e) => setForm({ ...form, systemOwner: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="text-[13px] text-neutral-500 block mb-1.5">系统原因</label>
              <textarea
                className={`${inputCls} min-h-20`}
                value={form.systemCause}
                onChange={(e) => setForm({ ...form, systemCause: e.target.value })}
                placeholder="管理、制度、流程层面的根因分析…"
              />
            </div>
          </section>

          {/* 根因分析（戴明 94/6）：先问机制，再问人 */}
          <section className="bg-white rounded-2xl p-6 shadow-sm space-y-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold text-neutral-400 tracking-wide">根因类别（选填）</h2>
              <span className="text-[11px] text-neutral-400">先问机制，再问人</span>
            </div>
            <div>
              <div className="flex gap-1 bg-neutral-200/60 p-1 rounded-xl w-fit">
                {([['', '未判定'], ['system', CAUSE_TYPE_LABEL.system], ['individual', CAUSE_TYPE_LABEL.individual]] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setForm({ ...form, causeType: key, countermeasureLevel: key === 'system' ? form.countermeasureLevel : '' })}
                    className={`px-4 py-1.5 rounded-lg text-[14px] transition-all ${form.causeType === key ? 'bg-white shadow-sm font-medium text-[#007AFF]' : 'text-neutral-500'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {form.causeType === 'individual' && (
                <p className="text-[12px] text-neutral-400 mt-2">个人原因落到具体纠正和教育；约 94% 的问题出在系统，判定前请再想一层机制。</p>
              )}
            </div>
            {form.causeType === 'system' && (
              <div className="space-y-3">
                <div>
                  <label className="text-[13px] text-neutral-500 block mb-1.5">对策层级（按 机制 → 技术 → 管理 的顺序想）</label>
                  <div className="flex gap-1 bg-neutral-200/60 p-1 rounded-xl w-fit">
                    {(['mechanism', 'technical', 'management'] as CountermeasureLevel[]).map((lv) => (
                      <button
                        key={lv}
                        onClick={() => setForm({ ...form, countermeasureLevel: lv })}
                        className={`px-5 py-1.5 rounded-lg text-[14px] transition-all ${form.countermeasureLevel === lv ? 'bg-white shadow-sm font-medium text-[#007AFF]' : 'text-neutral-500'}`}
                      >
                        {COUNTERMEASURE_LABEL[lv]}
                      </button>
                    ))}
                  </div>
                </div>
                {form.countermeasureLevel === 'management' && (
                  <div>
                    <label className="text-[13px] text-neutral-500 block mb-1.5">为什么机制和技术做不到？*</label>
                    <textarea
                      className={`${inputCls} min-h-20`}
                      value={form.countermeasureReason}
                      onChange={(e) => setForm({ ...form, countermeasureReason: e.target.value })}
                      placeholder="说明为何无法靠制度/流程/检查机制或技术装置解决，只能靠培训、教育、考核…"
                    />
                    {reasonMissing && <p className="text-[12px] text-[#D70015] mt-1.5">选「管理」必须填写理由，否则不能登记</p>}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 现场照片 */}
          <section className="bg-white rounded-2xl p-6 shadow-sm space-y-4">
            <h2 className="text-[13px] font-semibold text-neutral-400 tracking-wide">现场照片</h2>
            <div className="flex flex-wrap gap-3">
              {photoFiles.map((f, idx) => (
                <div key={idx} className="relative w-24 h-24 rounded-2xl overflow-hidden bg-neutral-100">
                  <img src={URL.createObjectURL(f)} alt="" className="w-full h-full object-cover" />
                  <button
                    onClick={() => setPhotoFiles(photoFiles.filter((_, i) => i !== idx))}
                    className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/55 text-white flex items-center justify-center"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              {photoFiles.length < 9 && (
                <button
                  onClick={() => photoRef.current?.click()}
                  className="w-24 h-24 rounded-2xl border-2 border-dashed border-neutral-200 flex flex-col items-center justify-center gap-1 text-neutral-400 hover:border-[#007AFF]/50 hover:text-[#007AFF] transition-colors"
                >
                  <ImagePlus className="w-6 h-6" />
                  <span className="text-[11px]">添加照片</span>
                </button>
              )}
            </div>
            <input
              ref={photoRef} type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? [])
                setPhotoFiles((cur) => [...cur, ...picked].slice(0, 9))
                e.target.value = ''
              }}
            />
            <p className="text-[11px] text-neutral-400">最多 9 张，单张不超过 10MB</p>
          </section>

          {/* 提交 */}
          <div className="flex justify-end pb-2">
            <button
              onClick={submitManual}
              disabled={!form.title.trim() || reasonMissing || submitting}
              className="px-8 py-2.5 rounded-full bg-[#007AFF] text-white text-[15px] font-medium disabled:opacity-40 hover:bg-[#0066D6] transition-colors flex items-center gap-2"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {submitting ? '上传中…' : '登记入库'}
            </button>
          </div>
        </div>
      ) : (
        <section className="bg-white rounded-2xl p-6 shadow-sm space-y-4">
          {/* 上传区 */}
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full border-2 border-dashed border-neutral-200 rounded-2xl py-10 flex flex-col items-center gap-2 text-neutral-500 hover:border-[#007AFF]/50 hover:text-[#007AFF] transition-colors"
          >
            {parsing ? <Loader2 className="w-6 h-6 animate-spin" /> : <FileUp className="w-6 h-6" />}
            <span className="text-[14px]">{parsing ? `${parseStage || '解析中…'}（后台解析，页面可正常操作）` : '点击选择 PPT / Word / Excel 文件（支持多选批量导入）'}</span>
            <span className="text-[12px] text-neutral-400">解析结果进入暂存区，确认后才入库；批量识别入库的隐患标记为「人工未复核」</span>
          </button>
          <input
            ref={fileRef} type="file" className="hidden" multiple
            accept=".ppt,.pptx,.doc,.docx,.xls,.xlsx,.csv"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? [])
              if (picked.length) onPickFiles(picked)
              e.target.value = ''
            }}
          />

          {/* 解析失败提示 */}
          {parseError && (
            <div className="px-4 py-2.5 rounded-xl bg-[#FF3B30]/10 text-[#D70015] text-[13px]">{parseError}</div>
          )}

          {/* 暂存区 */}
          {(drafts.length > 0 || reviews.length > 0) && (
            <div className="space-y-3">
              <div className="text-[13px] text-neutral-500 space-y-1">
                <div>
                  来自 <span className="text-neutral-800 font-medium">{sourceFiles.length} 个文件</span>，
                  识别出 {drafts.length} 条隐患{reviews.length > 0 && `、${reviews.length} 条复查核销`}，勾选确认生效的条目：
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {sourceFiles.map((f) => (
                    <span key={f.name} className="px-2 py-0.5 rounded-md bg-neutral-100 text-[11px] text-neutral-500">{f.name}</span>
                  ))}
                </div>
              </div>

              {/* 未识别页面：列出页码与内容预览，人工核对是否有漏网隐患 */}
              {skipped.length > 0 && (
                <details className="rounded-xl bg-[#FF9500]/8 border border-[#FF9500]/20 px-4 py-3">
                  <summary className="text-[13px] text-[#B25000] cursor-pointer select-none">
                    {skipped.length} 页未识别（封面、落实类页面属正常跳过），点击展开核对
                  </summary>
                  <ul className="mt-2 space-y-1.5">
                    {skipped.map((s) => (
                      <li key={`${s.fileName}#${s.page}`} className="text-[12px] text-neutral-500 flex gap-2">
                        {s.fileName && sourceFiles.length > 1 && (
                          <span className="shrink-0 text-neutral-400 max-w-40 truncate">{s.fileName}</span>
                        )}
                        <span className="shrink-0 font-medium text-neutral-600">第 {s.page} 页</span>
                        <span className="shrink-0 text-[#B25000]">{s.reason}</span>
                        {s.preview && <span className="truncate">{s.preview}…</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <ul className="space-y-2">
                {drafts.map((d) => {
                  const patchDraft = (patch: Partial<IssueDraft>) =>
                    setDrafts(drafts.map((x) => (x.key === d.key ? { ...x, ...patch } : x)))
                  return (
                    <li key={d.key} className="flex items-start gap-3 p-3 rounded-xl bg-neutral-50 border border-neutral-100">
                      <button onClick={() => patchDraft({ accepted: !d.accepted })} className="mt-0.5 text-[#007AFF]">
                        {d.accepted ? <CheckSquare className="w-4.5 h-4.5" /> : <Square className="w-4.5 h-4.5 text-neutral-300" />}
                      </button>
                      <div className="flex-1 space-y-1.5 min-w-0">
                        <input
                          className="w-full bg-transparent text-[14px] font-medium outline-none border-b border-transparent focus:border-[#007AFF]/40"
                          value={d.title}
                          onChange={(e) => patchDraft({ title: e.target.value })}
                        />
                        <div className="text-[12px] text-neutral-400 line-clamp-2">{d.description}</div>
                        {/* 从通报页提取的现场照片 */}
                        {(d.photos?.length ?? 0) > 0 && (
                          <div className="flex gap-1.5 flex-wrap items-center">
                            {d.photos!.map((f, i) => (
                              <img key={i} src={URL.createObjectURL(f)} alt="" className="w-12 h-12 rounded-md object-cover bg-neutral-200" />
                            ))}
                            <span className="text-[11px] text-neutral-400">{d.photos!.length} 张现场照片随隐患入库</span>
                          </div>
                        )}
                        <div className="flex gap-2 flex-wrap items-center">
                          <span className={`px-2 py-0.5 rounded-md text-[11px] font-medium ${isManagedWorkshop(d.locationGuess) ? 'bg-[#007AFF]/12 text-[#007AFF]' : 'bg-neutral-500/10 text-neutral-500'}`}>
                            {isManagedWorkshop(d.locationGuess) ? '成品车间 · 纳入闭环' : '其他车间 · 仅参考'}
                          </span>
                          {sourceFiles.length > 1 && d.fileName && (
                            <span className="px-2 py-0.5 rounded-md bg-neutral-100 text-[11px] text-neutral-400 max-w-48 truncate" title={d.fileName}>
                              {d.fileName}
                            </span>
                          )}
                          <select
                            className="text-[12px] bg-neutral-100 rounded-md px-2 py-1 outline-none"
                            value={d.categoryId ?? ''}
                            onChange={(e) => patchDraft({ categoryId: e.target.value || undefined })}
                          >
                            <option value="">{d.categoryGuess ? `类型（猜测：${d.categoryGuess}）` : '类型'}</option>
                            {withSubTags(categories).map(({ tag, depth }) => (
                              <option key={tag.id} value={tag.id}>{depth ? `${categories.find((p) => p.id === tag.parentId)?.name}-${tag.name}` : tag.name}</option>
                            ))}
                          </select>
                          <select
                            className="text-[12px] bg-neutral-100 rounded-md px-2 py-1 outline-none"
                            value={d.locationId ?? ''}
                            onChange={(e) => patchDraft({ locationId: e.target.value || undefined })}
                          >
                            <option value="">{d.locationGuess ? `区域（识别：${d.locationGuess}）` : '区域'}</option>
                            {locations.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                          <select
                            className="text-[12px] bg-neutral-100 rounded-md px-2 py-1 outline-none"
                            value={d.riskLevel}
                            onChange={(e) => patchDraft({ riskLevel: e.target.value as RiskLevel })}
                          >
                            {(['immediate', 'general', 'critical'] as const).map((r) => <option key={r} value={r}>{RISK_LABEL[r]}</option>)}
                          </select>
                        </div>
                        {/* 疑似重复：与库中既有隐患高度相似，入库前请人工核对是否同一问题 */}
                        {dupByKey[d.key]?.map((hit) => {
                          const hitIssue = issues.find((i) => i.id === hit.issueId)
                          const open = dupOpen === `${d.key}:${hit.issueId}`
                          return (
                            <div key={hit.issueId} className="rounded-lg bg-[#FF9500]/8 border border-[#FF9500]/25 px-2.5 py-1.5">
                              <button
                                onClick={() => setDupOpen(open ? null : `${d.key}:${hit.issueId}`)}
                                className="w-full flex items-center gap-1.5 text-left text-[12px] text-[#B25000]"
                              >
                                {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                                <span className="truncate flex-1">疑似重复：{hit.title}</span>
                                <span className="shrink-0">{Math.round(hit.score * 100)}%</span>
                                {hitIssue && <StatusBadge status={hitIssue.status} />}
                              </button>
                              {open && hitIssue && (
                                <div className="mt-1.5 pt-1.5 border-t border-[#FF9500]/20 space-y-1 text-[12px] text-neutral-500">
                                  {hitIssue.description && <p>{hitIssue.description}</p>}
                                  {hitIssue.fixNote && <p className="text-[#248A3D]">整改措施：{hitIssue.fixNote}</p>}
                                  <p className="text-neutral-400">
                                    {hitIssue.foundAt.slice(0, 10)} 发现 · {hitIssue.scope === 'managed' ? '成品车间 · 纳入闭环' : '其他车间 · 仅参考'}
                                    {hitIssue.sourceFile ? ` · 来源：${hitIssue.sourceFile}` : ''}
                                  </p>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </li>
                  )
                })}
              </ul>

              {/* 复查核销分区 */}
              {reviews.length > 0 && (
                <div className="space-y-2 pt-2">
                  <div className="flex items-center gap-1.5 text-[13px] text-neutral-500">
                    <ClipboardCheck className="w-4 h-4 text-[#34C759]" />
                    复查核销记录：命中库中待整改隐患的将在确认后自动闭环
                  </div>
                  <ul className="space-y-2">
                    {reviews.map((r) => {
                      const patchReview = (patch: Partial<ReviewDraft>) =>
                        setReviews(reviews.map((x) => (x.key === r.key ? { ...x, ...patch } : x)))
                      return (
                        <li key={r.key} className="flex items-start gap-3 p-3 rounded-xl bg-[#34C759]/5 border border-[#34C759]/15">
                          <button onClick={() => patchReview({ accepted: !r.accepted })} className="mt-0.5 text-[#34C759]">
                            {r.accepted ? <CheckSquare className="w-4.5 h-4.5" /> : <Square className="w-4.5 h-4.5 text-neutral-300" />}
                          </button>
                          <div className="flex-1 space-y-1 min-w-0">
                            <div className="text-[14px] font-medium">
                              复查第 {r.issueNoGuess ?? '？'} 期通报隐患
                              {r.workshop && <span className="text-neutral-400 font-normal"> · {r.workshop}</span>}
                            </div>
                            <div className="text-[12px] text-neutral-400 line-clamp-2">原问题：{r.snippet}…</div>
                            <div className="text-[12px] text-neutral-400">{r.conclusion}</div>
                            {/* 复查页提取的整改后照片 */}
                            {(r.photos?.length ?? 0) > 0 && (
                              <div className="flex gap-1.5 flex-wrap items-center">
                                {r.photos!.map((f, i) => (
                                  <img key={i} src={URL.createObjectURL(f)} alt="" className="w-12 h-12 rounded-md object-cover bg-neutral-200" />
                                ))}
                                <span className="text-[11px] text-neutral-400">{r.photos!.length} 张整改照片随核销追加</span>
                              </div>
                            )}
                            {r.matchedIssueId ? (
                              <span className="inline-block px-2 py-0.5 rounded-md text-[11px] font-medium bg-[#34C759]/12 text-[#248A3D]">
                                命中：{r.matchedIssueTitle} → 确认后闭环
                              </span>
                            ) : (
                              <span className="inline-block px-2 py-0.5 rounded-md text-[11px] font-medium bg-neutral-500/10 text-neutral-500">
                                未匹配到库中待整改隐患（可能早于系统建档），仅作记录
                              </span>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-1">
                <span className="text-[12px] text-neutral-400">整改期限按风险等级默认：重大 3 天 / 一般 15 天 / 即知即改当天</span>
                <button
                  onClick={confirmImport}
                  disabled={importing}
                  className="px-5 py-2 rounded-full bg-[#007AFF] text-white text-[14px] font-medium hover:bg-[#0066D6] transition-colors disabled:opacity-40 flex items-center gap-2"
                >
                  {importing && <Loader2 className="w-4 h-4 animate-spin" />}
                  {importing
                    ? '照片上传中…'
                    : `确认生效：入库 ${drafts.filter((d) => d.accepted).length} 条${
                        reviews.filter((r) => r.accepted && r.matchedIssueId).length > 0
                          ? ` + 核销 ${reviews.filter((r) => r.accepted && r.matchedIssueId).length} 条`
                          : ''
                      }`}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
