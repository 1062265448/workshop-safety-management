import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { FileUp, FolderOpen, Loader2, CheckSquare, Square, ClipboardCheck, ImagePlus, ThumbsUp, X, ChevronDown, ChevronRight, Sparkles, CheckCircle2 } from 'lucide-react'
import { uploadPhotos, useStore } from '@/lib/store'
import { isManagedWorkshop, TEAMS, countGridOwners, withSubTags } from '@/lib/config'
import { detectSource, parseFileOffthread, type SkippedPage } from '@/lib/import/parsers'
import { matchReview } from '@/lib/import/matchReview'
import { RISK_LABEL, RiskBadge, StatusBadge, CAUSE_TYPE_LABEL, COUNTERMEASURE_LABEL } from '@/components/badges'
import type { CauseType, CountermeasureLevel, IssueDraft, IssueSource, PrelabelSuggestion, ReviewDraft, RiskLevel, StyleCheckResult } from '@/types'

// ── 录入联动：与知识库语义比对，提示相似既有隐患 ──
interface SimilarCase { issueId: string; title: string; score: number; snippet: string; locationName?: string | null; foundAt?: string | null; status?: string | null }

/** 查重元数据核对：车间、日期任一明确不同 → 'diff'（不算同一问题）；信息缺失时不做否定判断（与后端 dupMetaVerdict 规则一致） */
function dupMetaVerdict(
  draft: { locationName?: string | null; foundAt?: string | null },
  hit: { locationName?: string | null; foundAt?: string | null },
): 'same' | 'diff' {
  const aLoc = (draft.locationName ?? '').trim()
  const bLoc = (hit.locationName ?? '').trim()
  if (aLoc && bLoc && aLoc !== bLoc) return 'diff'
  const day = (v?: string | null): string => (v ? /^(\d{4}-\d{2}-\d{2})/.exec(v)?.[1] ?? '' : '')
  const aDay = day(draft.foundAt)
  const bDay = day(hit.foundAt)
  if (aDay && bDay && aDay !== bDay) return 'diff'
  return 'same'
}

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
    isGood: false,
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

  // ── AI 能力：DeepSeek Key 在知识库页配置，未配置时 AI 按钮禁用/隐藏 ──
  const [llmReady, setLlmReady] = useState(false)
  useEffect(() => {
    api<{ apiKeySet: boolean }>('/knowledge/config').then((c) => setLlmReady(c.apiKeySet)).catch(() => setLlmReady(false))
  }, [])

  // ── 文字规范检查（手动录入「问题描述」）：四要素 + 模糊词拦截，只改写不编造 ──
  const [styleLoading, setStyleLoading] = useState(false)
  const [styleResult, setStyleResult] = useState<StyleCheckResult | null>(null)
  const [styleError, setStyleError] = useState('')
  const runStyleCheck = async () => {
    if (styleLoading) return
    setStyleLoading(true)
    setStyleError('')
    setStyleResult(null)
    try {
      const res = await api<StyleCheckResult>('/issues/style-check', {
        method: 'POST',
        body: JSON.stringify({ text: form.description }),
      })
      setStyleResult(res)
    } catch (e) {
      setStyleError(e instanceof Error ? e.message : '规范检查失败')
    } finally {
      setStyleLoading(false)
    }
  }

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
        // 正面典型（做得好）：不走整改闭环，自动沉淀知识库「好做法」
        isGood: form.isGood,
      })
      navigate('/issues')
    } finally {
      setSubmitting(false)
    }
  }

  // ── 文件导入（暂存区模式，支持批量多文件 / 整文件夹） ──
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const [parsing, setParsing] = useState(false)
  const [parseStage, setParseStage] = useState('')
  const [importing, setImporting] = useState(false)
  /** 导入进度：已完成照片上传/入库的条数；importTotal 为开始时锁定的总条数（分母必须锁定——导入过程中后台查重返回会改 accepted，实时算分母会"乱跳"） */
  const [uploadDone, setUploadDone] = useState(0)
  const [importTotal, setImportTotal] = useState(0)
  /** 导入成功标识：按钮处亮绿勾，停留后再跳转 */
  const [importOk, setImportOk] = useState(false)
  /** 本次批量解析的文件清单（名称 + 类型） */
  const [sourceFiles, setSourceFiles] = useState<Array<{ name: string; source: IssueSource }>>([])
  const [drafts, setDrafts] = useState<IssueDraft[]>([])
  const [reviews, setReviews] = useState<ReviewDraft[]>([])
  const [skipped, setSkipped] = useState<Array<SkippedPage & { fileName?: string }>>([])
  const [parseError, setParseError] = useState('')
  /** 导入查重：每条草稿与库中既有隐患的疑似重复命中（按草稿 key） */
  const [dupByKey, setDupByKey] = useState<Record<string, SimilarCase[]>>({})
  const [dupOpen, setDupOpen] = useState<string | null>(null)
  /** 同一问题默认跳过：批内标题归一化相同（key→保留条标题）；库中相似度≥75% 且车间/日期不冲突（key→最高命中）。
   *  库中命中的可点开详情弹窗人工改选是否导入 */
  const [intraDup, setIntraDup] = useState<Record<string, string>>({})
  const [sameDup, setSameDup] = useState<Record<string, SimilarCase>>({})
  /** 库中重复项详情弹窗：当前查看的草稿 key */
  const [dupDetailKey, setDupDetailKey] = useState<string | null>(null)

  // ── 暂存区分页：每页固定条数，整批渲染几百条会明显卡顿 ──
  const DRAFT_PAGE_SIZE = 20
  const [draftPage, setDraftPage] = useState(0)
  /** 照片 objectURL 缓存：同一 File 只建一次 URL，不随重渲染重复创建（旧写法每次渲染都新建，内存只涨不收） */
  const photoUrlCache = useRef(new Map<File, string>())
  const urlOf = (f: File): string => {
    let u = photoUrlCache.current.get(f)
    if (!u) {
      u = URL.createObjectURL(f)
      photoUrlCache.current.set(f, u)
    }
    return u
  }
  const clearPhotoUrls = () => {
    for (const u of photoUrlCache.current.values()) URL.revokeObjectURL(u)
    photoUrlCache.current.clear()
  }
  // 离开录入页时回收全部 objectURL
  useEffect(() => clearPhotoUrls, [])

  // ── AI 预标注（暂存区批量）：原则二——AI 只预判，人工「采用」后才填入字段 ──
  const [prelabeling, setPrelabeling] = useState(false)
  const [prelabelError, setPrelabelError] = useState('')

  /** AI 返回的类型名（子标签可能是「父-子」或仅原名）→ 现有标签 id */
  const findCategoryId = (name?: string | null): string | undefined => {
    if (!name) return undefined
    for (const { tag, depth } of withSubTags(categories)) {
      const display = depth ? `${categories.find((p) => p.id === tag.parentId)?.name}-${tag.name}` : tag.name
      if (display === name || tag.name === name) return tag.id
    }
    return undefined
  }

  /** 批量 AI 预标注：短文本后端自动跳过，单条失败不中断整批 */
  const runPrelabel = async () => {
    if (prelabeling || !drafts.length) return
    setPrelabeling(true)
    setPrelabelError('')
    try {
      const results = await api<PrelabelSuggestion[]>('/issues/prelabel', {
        method: 'POST',
        body: JSON.stringify({
          items: drafts.map((d) => ({ title: d.title, description: d.description, workshop: d.locationGuess })),
        }),
      })
      setDrafts(drafts.map((d, i) => ({ ...d, ai: results[i] ?? { error: 'AI 未返回该条结果' } })))
    } catch (e) {
      setPrelabelError(e instanceof Error ? e.message : 'AI 预标注失败')
    } finally {
      setPrelabeling(false)
    }
  }

  /** 采用 AI 建议：一键填入类型/等级/根因（填入后仍可人工修改） */
  const adoptAi = (key: string, ai: PrelabelSuggestion) => {
    setDrafts((cur) =>
      cur.map((x) =>
        x.key === key
          ? {
              ...x,
              categoryId: findCategoryId(ai.categoryName) ?? x.categoryId,
              riskLevel: ai.riskLevel ?? x.riskLevel,
              causeType: ai.causeType ?? x.causeType,
              countermeasureLevel: ai.causeType === 'system' ? ai.countermeasureLevel ?? x.countermeasureLevel : x.countermeasureLevel,
            }
          : x,
      ),
    )
  }

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
    setIntraDup({})
    setSameDup({})
    setDraftPage(0)
    clearPhotoUrls()
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
      // 批内去重：归一化标题（去空白标点）相同的条目只保留首条勾选，其余默认跳过（多文件导入时同一问题常在 PPT 与 Word 汇总表重复出现）
      const normTitle = (t: string) => t.toLowerCase().replace(/[\s　，。、；：""''（）()【】《》<>「」\-—·.!！?？]/g, '')
      const seenTitles = new Map<string, string>()
      const intra: Record<string, string> = {}
      const dedupedDrafts = withTags.map((d) => {
        const n = normTitle(d.title)
        if (!n) return d
        const firstTitle = seenTitles.get(n)
        if (firstTitle) {
          intra[d.key] = firstTitle
          return { ...d, accepted: false }
        }
        seenTitles.set(n, d.title)
        return d
      })
      setIntraDup(intra)
      setDrafts(dedupedDrafts)
      setReviews(withMatch)
      setSkipped(allSkipped)
      // 导入查重：草稿全部入暂存区后，批量比对库中既有隐患（不阻断导入，后台完成）
      // 规则：≥75% 且车间/日期不冲突 → 判定同一问题，默认跳过（可点开详情改选导入）；
      //       ≥75% 但车间或日期明确不同 → 不算同一问题，降级到「相似」提示由人工判断；
      //       35%~75% 相似问题 → 标出提示，是否录入由用户判断
      api<{ ready: boolean; results: SimilarCase[][] }>('/knowledge/similar-batch', {
        method: 'POST',
        body: JSON.stringify({ texts: dedupedDrafts.map((d) => `${d.title}\n${d.description}`), limit: 2 }),
      })
        .then((res) => {
          if (!res.ready) return
          const map: Record<string, SimilarCase[]> = {}
          const forced: Record<string, SimilarCase> = {}
          dedupedDrafts.forEach((d, i) => {
            const hits = res.results[i] ?? []
            const top = hits[0]
            if (!top) return
            const metaDiff = dupMetaVerdict({ locationName: d.locationGuess, foundAt: d.foundAtGuess }, top) === 'diff'
            if (top.score >= 0.75 && !metaDiff) {
              forced[d.key] = top
            } else if (top.score >= 0.35) {
              map[d.key] = hits.filter((x) => x.score >= 0.35)
            }
          })
          setDupByKey(map)
          if (Object.keys(forced).length) {
            setSameDup(forced)
            setDrafts((cur) => cur.map((x) => (forced[x.key] ? { ...x, accepted: false } : x)))
          }
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
    setUploadDone(0)
    setImportTotal(accepted.length)
    try {
      if (accepted.length) {
        // 并发池：同时只跑 4 条（每条含照片压缩+上传，无限制并发会把主线程打满反而更慢）
        const runPool = async <T,>(tasks: Array<() => Promise<T>>, size: number): Promise<T[]> => {
          const out = new Array<T>(tasks.length)
          let cursor = 0
          let finished = 0
          const worker = async () => {
            while (cursor < tasks.length) {
              const i = cursor++
              out[i] = await tasks[i]()
              finished++
              setUploadDone(finished)
            }
          }
          await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker))
          return out
        }
        const items = await runPool(
          accepted.map((d) => async () => {
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
              // 采用 AI 建议后回填的根因（作为人工字段入库）
              causeType: d.causeType,
              countermeasureLevel: d.causeType === 'system' ? d.countermeasureLevel : undefined,
              // AI 预填结果单独存档（原则二：只预判，不覆盖人工字段；供改动率统计与详情对照）
              aiCategory: d.ai && !d.ai.skipped && !d.ai.error ? d.ai.categoryName ?? null : null,
              aiRiskLevel: d.ai && !d.ai.skipped && !d.ai.error ? d.ai.riskLevel ?? null : null,
              aiCauseType: d.ai && !d.ai.skipped && !d.ai.error ? d.ai.causeType ?? null : null,
              aiSuggestion: d.ai && !d.ai.skipped && !d.ai.error ? d.ai.suggestion ?? null : null,
            }
          }),
          4,
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
      // 成功标识：先在按钮处亮绿勾停留 1.4 秒，让用户确认入库结果，再清空跳转
      setImportOk(true)
      await new Promise((r) => setTimeout(r, 1400))
      setDrafts([])
      setReviews([])
      setSkipped([])
      setSourceFiles([])
      setDupByKey({})
      setDupOpen(null)
      clearPhotoUrls()
      setUploadDone(0)
      navigate('/issues')
    } catch (e) {
      // 照片上传/入库失败要让用户看见原因，不能默默卡死
      setParseError(e instanceof Error ? e.message : '导入失败，请重试')
    } finally {
      setImporting(false)
      setImportOk(false)
    }
  }

  const inputCls = 'w-full px-3.5 py-2.5 rounded-xl bg-neutral-100/80 text-[14px] outline-none focus:ring-2 ring-[#007AFF]/30 transition-shadow'

  // ── 暂存区分页计算：只渲染当前页 20 条，勾选状态存在完整 drafts 里不受影响 ──
  const pageCount = Math.max(1, Math.ceil(drafts.length / DRAFT_PAGE_SIZE))
  const curPage = Math.min(draftPage, pageCount - 1)
  const pageDrafts = drafts.slice(curPage * DRAFT_PAGE_SIZE, (curPage + 1) * DRAFT_PAGE_SIZE)
  /** 本页全选/全不选：只作用于当前页普通条目（批内重复、库中已有的逐条决定，不被批量操作覆盖） */
  const setPageAccepted = (accepted: boolean) =>
    setDrafts((cur) =>
      cur.map((x) =>
        pageDrafts.some((p) => p.key === x.key) && !(intraDup[x.key] || sameDup[x.key]) ? { ...x, accepted } : x,
      ),
    )

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
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[13px] text-neutral-500">问题描述</label>
                {llmReady && (
                  <button
                    type="button"
                    onClick={runStyleCheck}
                    disabled={styleLoading || form.description.replace(/\s+/g, '').length < 10}
                    title="按「谁、做什么、做到什么程度、何时完成」四要素检查，拦截「加强、尽快、适当」类模糊词（少于 10 字不检查）"
                    className="text-[12px] text-[#007AFF] hover:underline disabled:text-neutral-300 disabled:no-underline flex items-center gap-1"
                  >
                    {styleLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                    规范检查
                  </button>
                )}
              </div>
              <textarea
                className={`${inputCls} min-h-28`}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="位置、现状、风险说明…"
              />
              {/* 规范检查结果：问题列表 + AI 改写稿 + 采用改写 */}
              {styleError && <p className="text-[12px] text-[#D70015] mt-1.5">{styleError}</p>}
              {styleResult && !styleResult.skipped && (
                <div className="mt-2 rounded-xl bg-neutral-50 border border-neutral-100 px-3.5 py-3 space-y-2">
                  {styleResult.ok ? (
                    <p className="text-[12px] text-[#248A3D]">文本符合「谁、做什么、做到什么程度、何时完成」四要素，无需改写</p>
                  ) : (
                    <>
                      <ul className="space-y-1">
                        {(styleResult.problems ?? []).map((p, i) => (
                          <li key={i} className="text-[12px] text-[#B25000] flex gap-1.5">
                            <span className="shrink-0">·</span>
                            {p}
                          </li>
                        ))}
                      </ul>
                      {styleResult.rewrite && (
                        <div className="rounded-lg bg-white border border-neutral-200 px-3 py-2">
                          <div className="text-[11px] text-neutral-400 mb-1">AI 改写稿（缺信息以【待补】占位，采用前请核对）</div>
                          <p className="text-[13px] text-neutral-700 leading-relaxed whitespace-pre-wrap">{styleResult.rewrite}</p>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          if (styleResult.rewrite) setForm({ ...form, description: styleResult.rewrite })
                          setStyleResult(null)
                        }}
                        className="text-[12px] text-[#007AFF] hover:underline"
                      >
                        采用改写
                      </button>
                    </>
                  )}
                </div>
              )}
              {styleResult?.skipped === 'too_short' && (
                <p className="text-[12px] text-neutral-400 mt-1.5">文本少于 10 字，未送 AI 检查</p>
              )}
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
          <div className="flex items-center justify-end gap-4 pb-2">
            {/* 正面典型：做得好的做法，不进整改闭环，自动沉淀到知识库「好做法」 */}
            <button
              type="button"
              onClick={() => setForm({ ...form, isGood: !form.isGood })}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-medium transition-colors ${
                form.isGood
                  ? 'bg-[#34C759] text-white'
                  : 'text-[#248A3D] border border-[#34C759]/40 hover:bg-[#34C759]/8'
              }`}
            >
              <ThumbsUp className="w-3.5 h-3.5" />
              {form.isGood ? '已选好做法（正面典型）' : '这是好做法（正面典型）'}
            </button>
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

          {/* 文件夹批量导入：整个督察通报目录一次选入（含子文件夹），自动过滤出可解析的通报文件 */}
          <div className="flex justify-center">
            <button
              onClick={() => dirRef.current?.click()}
              className="flex items-center gap-1.5 text-[13px] text-[#007AFF] hover:underline"
            >
              <FolderOpen className="w-4 h-4" />
              或选择通报文件夹，批量导入里面全部督察通报
            </button>
          </div>
          <input
            ref={dirRef} type="file" className="hidden" multiple
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []).filter((f) => detectSource(f.name))
              if (picked.length) onPickFiles(picked)
              else if (Array.from(e.target.files ?? []).length) setParseError('所选文件夹里没有可解析的通报文件（支持 PPT/Word/Excel）')
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
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    来自 <span className="text-neutral-800 font-medium">{sourceFiles.length} 个文件</span>，
                    识别出 {drafts.length} 条隐患{reviews.length > 0 && `、${reviews.length} 条复查核销`}，勾选确认生效的条目：
                  </div>
                  {/* AI 预标注：AI 只预判，行内灰色小字展示，人工「采用」才填入字段；未配置 Key 时禁用 */}
                  <button
                    onClick={runPrelabel}
                    disabled={!llmReady || prelabeling || importing || drafts.length === 0}
                    title={llmReady ? '调 DeepSeek 给每条草稿预判类型/等级/根因/整改建议（少于 30 字的条目自动跳过）' : '请先在知识库页「API 配置」中填写 DeepSeek Key'}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-[#007AFF]/40 text-[#007AFF] text-[12px] font-medium hover:bg-[#007AFF]/8 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    {prelabeling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    {prelabeling ? 'AI 预标注中…' : 'AI 预标注'}
                  </button>
                </div>
                {!llmReady && (
                  <div className="text-[12px] text-neutral-400">AI 预标注需先在知识库页配置 DeepSeek Key</div>
                )}
                {prelabelError && <div className="text-[12px] text-[#D70015]">{prelabelError}</div>}
                {/* 去重摘要：批内重复不可勾选；库中已有默认跳过但可点开详情改选；相似问题由人工判断 */}
                {(Object.keys(intraDup).length > 0 || Object.keys(sameDup).length > 0) && (
                  <div className="text-[12px] text-[#B25000]">
                    判定为同一问题默认跳过 {Object.keys(intraDup).length + Object.keys(sameDup).length} 条
                    （批内重复 {Object.keys(intraDup).length} · 库中已有 {Object.keys(sameDup).length}）；
                    点「库中已有」徽标可查看库中详情并改选导入，标注「相似」的条目请人工判断是否入库
                  </div>
                )}
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
              {/* 分页控制：整批几百条只渲染当前页 20 条，勾选状态跨页保留 */}
              {pageCount > 1 && (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setDraftPage(curPage - 1)}
                      disabled={curPage === 0 || importing}
                      className="px-2.5 py-1 rounded-lg bg-neutral-100 text-[12px] text-neutral-600 hover:bg-neutral-200/70 transition-colors disabled:opacity-30 disabled:hover:bg-neutral-100"
                    >
                      上一页
                    </button>
                    <span className="text-[12px] text-neutral-500 px-1">
                      第 {curPage + 1} / {pageCount} 页 · 本页 {pageDrafts.length} 条 / 共 {drafts.length} 条
                    </span>
                    <button
                      onClick={() => setDraftPage(curPage + 1)}
                      disabled={curPage >= pageCount - 1 || importing}
                      className="px-2.5 py-1 rounded-lg bg-neutral-100 text-[12px] text-neutral-600 hover:bg-neutral-200/70 transition-colors disabled:opacity-30 disabled:hover:bg-neutral-100"
                    >
                      下一页
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setPageAccepted(true)} disabled={importing} className="text-[12px] text-[#007AFF] hover:underline disabled:opacity-40">
                      全选本页
                    </button>
                    <span className="text-neutral-300">|</span>
                    <button onClick={() => setPageAccepted(false)} disabled={importing} className="text-[12px] text-neutral-500 hover:underline disabled:opacity-40">
                      全不选本页
                    </button>
                  </div>
                </div>
              )}
              <ul className="space-y-2">
                {pageDrafts.map((d) => {
                  const patchDraft = (patch: Partial<IssueDraft>) =>
                    setDrafts(drafts.map((x) => (x.key === d.key ? { ...x, ...patch } : x)))
                  return (
                    <li key={d.key} className="flex items-start gap-3 p-3 rounded-xl bg-neutral-50 border border-neutral-100">
                      {/* 勾选：批内重复（真重复）禁止勾选；库中已有条目默认可改选——点开「库中已有」徽标查看详情后决定 */}
                      <button
                        onClick={() => {
                          if (intraDup[d.key] || importing) return
                          patchDraft({ accepted: !d.accepted })
                        }}
                        disabled={!!intraDup[d.key] || importing}
                        className="mt-0.5 text-[#007AFF] disabled:cursor-not-allowed"
                      >
                        {d.accepted ? <CheckSquare className="w-4.5 h-4.5" /> : <Square className={`w-4.5 h-4.5 ${intraDup[d.key] ? 'text-neutral-200' : 'text-neutral-300'}`} />}
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
                              <img key={i} src={urlOf(f)} alt="" className="w-12 h-12 rounded-md object-cover bg-neutral-200" />
                            ))}
                            <span className="text-[11px] text-neutral-400">{d.photos!.length} 张现场照片随隐患入库</span>
                          </div>
                        )}
                        <div className="flex gap-2 flex-wrap items-center">
                          {/* 去重跳过原因：同一问题（批内重复 / 库中高相似）强制跳过，不可恢复 */}
                          {intraDup[d.key] && (
                            <span
                              className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-[#FF3B30]/10 text-[#D70015]"
                              title={`与本批次「${intraDup[d.key]}」是同一问题，不重复录入`}
                            >
                              同一问题 · 批内重复
                            </span>
                          )}
                          {sameDup[d.key] && (
                            <button
                              onClick={() => !importing && setDupDetailKey(d.key)}
                              title={`与库中「${sameDup[d.key].title}」相似度 ${Math.round(sameDup[d.key].score * 100)}%，判定为同一问题，默认不录入；点击查看库中详情，可改选导入`}
                              className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-[#FF3B30]/10 text-[#D70015] hover:bg-[#FF3B30]/20 transition-colors"
                            >
                              同一问题 · 库中已有 {Math.round(sameDup[d.key].score * 100)}%（点击复核）
                            </button>
                          )}
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
                        {/* AI 预标注建议：灰色小字行内展示，人工「采用」一键填入对应字段 */}
                        {d.ai && (
                          <div className="rounded-lg bg-neutral-100/70 px-2.5 py-1.5 flex items-start gap-2">
                            <Sparkles className="w-3 h-3 mt-0.5 shrink-0 text-neutral-400" />
                            {d.ai.skipped === 'too_short' ? (
                              <span className="text-[11px] text-neutral-400">文本少于 30 字，未送 AI 预标注</span>
                            ) : d.ai.error ? (
                              <span className="text-[11px] text-[#B25000]">AI 预标注未成功：{d.ai.error}（不影响其他条目，可人工填写）</span>
                            ) : (
                              <>
                                <span className="flex-1 text-[11px] text-neutral-400 leading-relaxed">
                                  AI 建议：
                                  {[
                                    d.ai.categoryName && `类型 ${d.ai.categoryName}`,
                                    d.ai.riskLevel && `等级 ${RISK_LABEL[d.ai.riskLevel]}`,
                                    d.ai.causeType &&
                                      `根因 ${CAUSE_TYPE_LABEL[d.ai.causeType]}${d.ai.causeType === 'system' && d.ai.countermeasureLevel ? `（对策：${COUNTERMEASURE_LABEL[d.ai.countermeasureLevel]}）` : ''}`,
                                    d.ai.suggestion && `整改：${d.ai.suggestion}`,
                                  ]
                                    .filter(Boolean)
                                    .join('；') || '信息不足，未给出建议'}
                                </span>
                                <button
                                  onClick={() => adoptAi(d.key, d.ai!)}
                                  className="shrink-0 text-[11px] text-[#007AFF] hover:underline"
                                >
                                  采用
                                </button>
                              </>
                            )}
                          </div>
                        )}
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
                                <span className="truncate flex-1">相似问题：{hit.title}</span>
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
                          <button onClick={() => !importing && patchReview({ accepted: !r.accepted })} disabled={importing} className="mt-0.5 text-[#34C759] disabled:opacity-40">
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
                                  <img key={i} src={urlOf(f)} alt="" className="w-12 h-12 rounded-md object-cover bg-neutral-200" />
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
                {importOk ? (
                  <span className="text-[12px] text-[#248A3D]">入库成功，正在跳转问题库…</span>
                ) : (
                  <span className="text-[12px] text-neutral-400">整改期限按风险等级默认：重大 3 天 / 一般 15 天 / 即知即改当天</span>
                )}
                <button
                  onClick={confirmImport}
                  disabled={importing}
                  className={`px-5 py-2 rounded-full text-[14px] font-medium flex items-center gap-2 transition-colors disabled:opacity-40 ${
                    importOk ? 'bg-[#34C759] text-white' : 'bg-[#007AFF] text-white hover:bg-[#0066D6]'
                  }`}
                >
                  {importOk ? (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      已成功入库 {importTotal} 条
                    </>
                  ) : (
                    <>
                      {importing && <Loader2 className="w-4 h-4 animate-spin" />}
                      {importing
                        ? `导入中 ${uploadDone}/${importTotal} 条…`
                        : `确认生效：入库 ${drafts.filter((d) => d.accepted).length} 条${
                            reviews.filter((r) => r.accepted && r.matchedIssueId).length > 0
                              ? ` + 核销 ${reviews.filter((r) => r.accepted && r.matchedIssueId).length} 条`
                              : ''
                          }`}
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 同一问题复核弹窗：展示库中重复项详情，人工决定是否仍要导入 */}
      {dupDetailKey && sameDup[dupDetailKey] && (() => {
        const hit = sameDup[dupDetailKey]
        const draft = drafts.find((x) => x.key === dupDetailKey)
        const hitIssue = issues.find((i) => i.id === hit.issueId)
        const locMismatch = !!(draft?.locationGuess && hit.locationName && draft.locationGuess.trim() !== hit.locationName.trim())
        const dayOf = (v?: string | null) => (v ? /^(\d{4}-\d{2}-\d{2})/.exec(v)?.[1] : undefined)
        const dateMismatch = !!(dayOf(draft?.foundAtGuess) && dayOf(hit.foundAt ?? hitIssue?.foundAt) && dayOf(draft?.foundAtGuess) !== dayOf(hit.foundAt ?? hitIssue?.foundAt))
        const setDraftAccepted = (accepted: boolean) =>
          setDrafts((cur) => cur.map((x) => (x.key === dupDetailKey ? { ...x, accepted } : x)))
        return (
          <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={() => setDupDetailKey(null)}>
            <div
              className="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[85vh] overflow-y-auto p-6 space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-[16px] font-semibold">库中已有疑似同一问题</h2>
                  <p className="text-[12px] text-neutral-400 mt-0.5">相似度 {Math.round(hit.score * 100)}%，默认不重复录入；核对后可改选</p>
                </div>
                <button onClick={() => setDupDetailKey(null)} className="text-neutral-400 hover:text-neutral-600 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* 库中已有条目 */}
              <div className="rounded-xl bg-neutral-50 border border-neutral-100 p-4 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] text-neutral-400 shrink-0">库中</span>
                  {hitIssue && <StatusBadge status={hitIssue.status} overdue={false} />}
                  {hitIssue?.scope === 'reference' && (
                    <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-neutral-500/10 text-neutral-500">参考</span>
                  )}
                </div>
                <p className="text-[14px] font-medium leading-snug">{hit.title}</p>
                <p className="text-[12px] text-neutral-500 whitespace-pre-wrap">{(hitIssue?.description || hit.snippet)?.slice(0, 300)}</p>
                {hitIssue?.fixNote && <p className="text-[12px] text-[#248A3D]">整改措施:{hitIssue.fixNote}</p>}
                <p className="text-[12px] text-neutral-400">
                  {hit.locationName ?? '未标注车间'} · {(hit.foundAt ?? hitIssue?.foundAt ?? '').slice(0, 10) || '日期未知'} 发现
                  {hitIssue?.sourceFile ? ` · 来源:${hitIssue.sourceFile}` : ''}
                </p>
              </div>

              {/* 本次导入条目对比 */}
              {draft && (
                <div className="rounded-xl bg-[#FF9500]/6 border border-[#FF9500]/20 p-4 space-y-2">
                  <span className="text-[11px] text-[#B25000]">本次待导入</span>
                  <p className="text-[14px] font-medium leading-snug">{draft.title}</p>
                  <div className="text-[12px] space-y-0.5">
                    <p className={locMismatch ? 'text-[#B25000] font-medium' : 'text-neutral-500'}>
                      车间：{draft.locationGuess ?? '未标注'}{locMismatch ? `（库中为 ${hit.locationName}，车间不同不算同一问题）` : ''}
                    </p>
                    <p className={dateMismatch ? 'text-[#B25000] font-medium' : 'text-neutral-500'}>
                      日期：{draft.foundAtGuess?.slice(0, 10) ?? '未识别'}{dateMismatch ? `（库中为 ${(hit.foundAt ?? hitIssue?.foundAt ?? '').slice(0, 10)}，日期不同不算同一问题）` : ''}
                    </p>
                  </div>
                </div>
              )}

              {/* 人工改选 */}
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <button
                  onClick={() => draft && setDraftAccepted(!draft.accepted)}
                  className="text-[#007AFF]"
                >
                  {draft?.accepted ? <CheckSquare className="w-4.5 h-4.5" /> : <Square className="w-4.5 h-4.5 text-neutral-300" />}
                </button>
                <span className="text-[13px] text-neutral-600">仍要导入此问题（勾选后随本次导入入库）</span>
              </label>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
