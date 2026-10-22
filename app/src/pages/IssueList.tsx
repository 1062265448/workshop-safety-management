import { useEffect, useMemo, useRef, useState } from 'react'
import { BookMarked, CheckCircle2, ChevronLeft, ChevronRight, Circle, ImagePlus, Plus, RotateCcw, Search, Sparkles, ThumbsUp, Trash2, X, XCircle } from 'lucide-react'
import { api, isOverdue, uploadPhotos, useStore } from '@/lib/store'
import { TEAMS, countGridOwners, gridOwnerTier, withSubTags } from '@/lib/config'
import { fmtDate, fmtDateTime } from '@/lib/format'
import { CAUSE_TYPE_LABEL, COUNTERMEASURE_LABEL, REG_CATEGORY_META, RISK_LABEL, RiskBadge, SOURCE_LABEL, STAGE_LABEL, STAGE_ORDER, STATUS_LABEL, StatusBadge } from '@/components/badges'
import { RELEVANCE_BADGE } from '@/pages/Annotations'
import type { CauseType, CountermeasureLevel, IssueStatus, KnowledgeDocOption, Regulation, SafetyIssue } from '@/types'

/** 状态机的下一步动作 */
const NEXT_ACTION: Partial<Record<IssueStatus, { label: string; to: IssueStatus }>> = {
  pending: { label: '开始整改', to: 'fixing' },
  fixing: { label: '提交复查', to: 'review' },
  review: { label: '确认闭环', to: 'closed' },
}

export default function IssueList() {
  const { issues, tags, annotations, updateIssue, removeIssue, recheckIssue, advanceStage, fetchBin, restoreIssue, hardDeleteIssue, linkRegulation, unlinkRegulation } = useStore()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<IssueStatus | ''>('')
  const [categoryId, setCategoryId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [scope, setScope] = useState<'' | 'managed' | 'reference'>('managed')
  const [reviewed, setReviewed] = useState<'' | 'unreviewed' | 'reviewed'>('')
  /** 发现时间范围筛选（按 foundAt 日期，含边界） */
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  /** 排序：默认发现日期倒序，可切录入日期倒序 */
  const [sortBy, setSortBy] = useState<'foundAt' | 'createdAt'>('foundAt')
  /** 列表分页：每页 20 条 */
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 20
  /** 回收站弹窗 */
  const [binOpen, setBinOpen] = useState(false)
  const [binItems, setBinItems] = useState<SafetyIssue[]>([])
  const [binLoading, setBinLoading] = useState(false)
  /** 待二次确认彻底删除的隐患 id */
  const [pendingHardDeleteId, setPendingHardDeleteId] = useState<string | null>(null)
  /** 待二次确认删除的隐患 id（内联确认，不用原生 confirm，兼容内嵌浏览器） */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  /** 大图查看：当前隐患 id + 照片下标 */
  const [lightbox, setLightbox] = useState<{ issueId: string; index: number } | null>(null)
  /** 待二次确认删除的照片路径 */
  const [pendingPhotoDelete, setPendingPhotoDelete] = useState<string | null>(null)
  /** 正在给哪条隐患补传照片 */
  const [photoTargetId, setPhotoTargetId] = useState<string | null>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  /** 详情弹层：当前查看的隐患 id */
  const [detailId, setDetailId] = useState<string | null>(null)
  /** 详情层编辑模式 */
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({
    title: '', description: '', categoryId: '', locationId: '',
    riskLevel: 'general' as SafetyIssue['riskLevel'], assignee: '', deadline: '', fixNote: '',
    team: '', gridOperator: '', gridOwner: '', systemOwner: '', systemCause: '',
    causeType: '' as '' | CauseType, countermeasureLevel: '' as '' | CountermeasureLevel, countermeasureReason: '',
  })
  /** 复查间隔编辑草稿（天） */
  const [intervalDraft, setIntervalDraft] = useState('')
  /** 制度沉淀完成表单：制度要点 + 关联知识库条目 */
  const [institutionDraft, setInstitutionDraft] = useState({ note: '', docId: '' })
  const [knowledgeDocs, setKnowledgeDocs] = useState<KnowledgeDocOption[]>([])
  /** 法规依据：搜索关键词 + 候选结果（编辑模式下添加关联用） */
  const [regQ, setRegQ] = useState('')
  const [regResults, setRegResults] = useState<Regulation[]>([])
  const [regSearching, setRegSearching] = useState(false)
  /** 编辑表单根因校验：系统原因选「管理」时必须说明理由 */
  const editReasonMissing = editForm.causeType === 'system' && editForm.countermeasureLevel === 'management' && !editForm.countermeasureReason.trim()

  // ── AI 范例学习：已复核且已分类的隐患可设为 AI 范例（对齐主任口径，越用越准） ──
  const [exampleSaving, setExampleSaving] = useState(false)
  const [exampleSaved, setExampleSaved] = useState(false)
  const [exampleError, setExampleError] = useState('')
  const setAsExample = async (issue: SafetyIssue) => {
    const categoryName = tagName(issue.categoryId)
    if (!categoryName || exampleSaving) return
    setExampleSaving(true)
    setExampleError('')
    try {
      await api('/issues/prelabel/examples', {
        method: 'POST',
        body: JSON.stringify({ categoryName, title: issue.title, description: issue.description }),
      })
      setExampleSaved(true)
    } catch (e) {
      setExampleError(e instanceof Error ? e.message : '设为范例失败')
    } finally {
      setExampleSaving(false)
    }
  }

  const categories = tags.filter((t) => t.group === 'category')
  const locations = tags.filter((t) => t.group === 'location')
  /** 标签显示名：子标签带父标签前缀（如「电气设施-电缆破损」） */
  const tagName = (id?: string) => {
    const t = tags.find((t) => t.id === id)
    if (!t) return undefined
    if (t.parentId) {
      const p = tags.find((x) => x.id === t.parentId)
      if (p) return `${p.name}-${t.name}`
    }
    return t.name
  }

  /** 网格责任人重复统计：同一责任人在成品车间隐患中出现 ≥2 次时专门提醒 */
  const gridOwnerCounts = useMemo(() => countGridOwners(issues), [issues])

  const filtered = useMemo(
    () =>
      issues
        .filter((i) => !scope || i.scope === scope)
        .filter((i) => !q || i.title.includes(q) || i.description.includes(q))
        .filter((i) => !status || i.status === status)
        .filter((i) => !categoryId || i.categoryId === categoryId)
        .filter((i) => !locationId || i.locationId === locationId)
        .filter((i) => !reviewed || (reviewed === 'unreviewed' ? i.reviewed === false : i.reviewed !== false))
        // 发现时间范围：ISO 字符串前 10 位即日期，字典序比较即日期比较
        .filter((i) => !dateFrom || i.foundAt.slice(0, 10) >= dateFrom)
        .filter((i) => !dateTo || i.foundAt.slice(0, 10) <= dateTo)
        .sort((a, b) =>
          sortBy === 'foundAt'
            ? b.foundAt.localeCompare(a.foundAt) || b.createdAt.localeCompare(a.createdAt)
            : b.createdAt.localeCompare(a.createdAt) || b.foundAt.localeCompare(a.foundAt),
        ),
    [issues, q, status, categoryId, locationId, scope, reviewed, dateFrom, dateTo, sortBy],
  )

  // 任一筛选条件变化时回到第一页
  useEffect(() => setPage(0), [q, status, categoryId, locationId, scope, reviewed, dateFrom, dateTo, sortBy])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const curPage = Math.min(page, pageCount - 1)
  const pageItems = filtered.slice(curPage * PAGE_SIZE, (curPage + 1) * PAGE_SIZE)

  const transition = (issue: SafetyIssue) => {
    const next = NEXT_ACTION[issue.status]
    if (!next) return
    updateIssue(issue.id, {
      status: next.to,
      closedAt: next.to === 'closed' ? new Date().toISOString() : issue.closedAt,
    })
  }

  const confirmRemove = (issue: SafetyIssue) => {
    if (pendingDeleteId === issue.id) {
      removeIssue(issue.id)
      setPendingDeleteId(null)
      setDetailId((cur) => (cur === issue.id ? null : cur))
    } else {
      setPendingDeleteId(issue.id)
      // 3 秒未确认自动复位
      setTimeout(() => setPendingDeleteId((cur) => (cur === issue.id ? null : cur)), 3000)
    }
  }

  /** 给已有隐患补传照片（整改前后照片） */
  const addPhotosTo = async (issueId: string, files: File[]) => {
    const issue = issues.find((i) => i.id === issueId)
    if (!issue || !files.length) return
    const paths = await uploadPhotos(files)
    updateIssue(issueId, { photos: [...(issue.photos ?? []), ...paths].slice(0, 9) })
  }

  /** 删除单张照片（两段式确认） */
  const confirmRemovePhoto = (issue: SafetyIssue, path: string) => {
    if (pendingPhotoDelete === path) {
      const next = issue.photos.filter((p) => p !== path)
      updateIssue(issue.id, { photos: next })
      setPendingPhotoDelete(null)
      setLightbox((cur) => (cur && next.length === 0 ? null : cur ? { ...cur, index: Math.min(cur.index, Math.max(next.length - 1, 0)) } : cur))
    } else {
      setPendingPhotoDelete(path)
      setTimeout(() => setPendingPhotoDelete((cur) => (cur === path ? null : cur)), 3000)
    }
  }

  const lightboxIssue = lightbox ? issues.find((i) => i.id === lightbox.issueId) : undefined
  const detailIssue = detailId ? issues.find((i) => i.id === detailId) : undefined

  /** 进入编辑模式：以当前值初始化表单 */
  const startEdit = (issue: SafetyIssue) => {
    setEditForm({
      title: issue.title,
      description: issue.description,
      categoryId: issue.categoryId ?? '',
      locationId: issue.locationId ?? '',
      riskLevel: issue.riskLevel,
      assignee: issue.assignee ?? '',
      deadline: issue.deadline ? fmtDate(issue.deadline) : '',
      fixNote: issue.fixNote ?? '',
      team: issue.team ?? '',
      gridOperator: issue.gridOperator ?? '',
      gridOwner: issue.gridOwner ?? '',
      systemOwner: issue.systemOwner ?? '',
      systemCause: issue.systemCause ?? '',
      causeType: issue.causeType ?? '',
      countermeasureLevel: issue.countermeasureLevel ?? '',
      countermeasureReason: issue.countermeasureReason ?? '',
    })
    setEditing(true)
  }

  /** 保存编辑：留空的可选字段发 null 让后端清空（pick 只跳过 undefined，null 会落库为 NULL） */
  const saveEdit = () => {
    if (!detailIssue || !editForm.title.trim() || editReasonMissing) return
    updateIssue(detailIssue.id, {
      title: editForm.title.trim(),
      description: editForm.description.trim(),
      categoryId: (editForm.categoryId || null) as SafetyIssue['categoryId'],
      locationId: (editForm.locationId || null) as SafetyIssue['locationId'],
      riskLevel: editForm.riskLevel,
      assignee: (editForm.assignee.trim() || null) as SafetyIssue['assignee'],
      deadline: (editForm.deadline ? new Date(editForm.deadline).toISOString() : null) as SafetyIssue['deadline'],
      fixNote: (editForm.fixNote.trim() || null) as SafetyIssue['fixNote'],
      team: (editForm.team || null) as SafetyIssue['team'],
      gridOperator: (editForm.gridOperator.trim() || null) as SafetyIssue['gridOperator'],
      gridOwner: (editForm.gridOwner.trim() || null) as SafetyIssue['gridOwner'],
      systemOwner: (editForm.systemOwner.trim() || null) as SafetyIssue['systemOwner'],
      systemCause: (editForm.systemCause.trim() || null) as SafetyIssue['systemCause'],
      causeType: (editForm.causeType || null) as SafetyIssue['causeType'],
      countermeasureLevel: (editForm.causeType === 'system' && editForm.countermeasureLevel ? editForm.countermeasureLevel : null) as SafetyIssue['countermeasureLevel'],
      countermeasureReason: (editForm.countermeasureReason.trim() || null) as SafetyIssue['countermeasureReason'],
    })
    setEditing(false)
  }

  const closeDetail = () => { setDetailId(null); setEditing(false) }

  /** 打开详情层，同时初始化复查间隔草稿与制度沉淀草稿 */
  const openDetail = (issue: SafetyIssue) => {
    setDetailId(issue.id)
    setIntervalDraft(String(issue.recheckIntervalDays ?? 7))
    setInstitutionDraft({ note: issue.institutionNote ?? '', docId: issue.linkedKnowledgeDocId ?? '' })
    setRegQ('')
    setRegResults([])
    setExampleSaved(false)
    setExampleError('')
    // 制度沉淀阶段需要知识库条目下拉，首次打开详情时拉一次
    if (knowledgeDocs.length === 0) api<KnowledgeDocOption[]>('/issues/knowledge-docs').then(setKnowledgeDocs).catch(() => {})
  }

  /** 法规依据搜索：停顿 300ms 后按关键词检索法规库（空关键词显示全部前 20 条） */
  useEffect(() => {
    if (!editing || !detailId) return
    const timer = setTimeout(async () => {
      setRegSearching(true)
      try {
        const q = regQ.trim()
        setRegResults(await api<Regulation[]>(`/regulations${q ? `?q=${encodeURIComponent(q)}` : ''}`))
      } catch {
        setRegResults([])
      } finally {
        setRegSearching(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [regQ, editing, detailId])

  /** 保存复查间隔（失焦时，值有变化才提交） */
  const saveInterval = () => {
    if (!detailIssue) return
    const v = Math.max(1, Math.round(Number(intervalDraft) || 7))
    if (v !== detailIssue.recheckIntervalDays) updateIssue(detailIssue.id, { recheckIntervalDays: v })
    setIntervalDraft(String(v))
  }

  /** 打开回收站并拉取已删除条目 */
  const openBin = async () => {
    setBinOpen(true)
    setBinLoading(true)
    try {
      setBinItems(await fetchBin())
    } finally {
      setBinLoading(false)
    }
  }

  const handleRestore = async (id: string) => {
    restoreIssue(id)
    setBinItems((cur) => cur.filter((i) => i.id !== id))
  }

  /** 彻底删除（两段式确认，不可恢复） */
  const confirmHardDelete = (issue: SafetyIssue) => {
    if (pendingHardDeleteId === issue.id) {
      hardDeleteIssue(issue.id)
      setBinItems((cur) => cur.filter((i) => i.id !== issue.id))
      setPendingHardDeleteId(null)
    } else {
      setPendingHardDeleteId(issue.id)
      setTimeout(() => setPendingHardDeleteId((cur) => (cur === issue.id ? null : cur)), 3000)
    }
  }

  const selectCls = 'px-3 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none'

  return (
    <div className="max-w-5xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">问题库</h1>
        <p className="text-sm text-neutral-500 mt-1">
          全部隐患记录 · 共 {issues.length} 条{filtered.length !== issues.length && `（筛选后 ${filtered.length} 条）`}
        </p>
      </header>

      {/* 范围页签：成品车间（闭环管理）/ 其他车间（参考） */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 bg-neutral-200/60 p-1 rounded-xl w-fit">
          {([['managed', '成品车间'], ['reference', '其他车间（参考）'], ['', '全部']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setScope(key)}
              className={`px-4 py-1.5 rounded-lg text-[13px] transition-colors ${scope === key ? 'bg-white shadow-sm font-medium' : 'text-neutral-500'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={openBin}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-white border border-neutral-200 text-[13px] text-neutral-500 hover:text-[#007AFF] hover:border-[#007AFF]/40 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          回收站
        </button>
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white border border-neutral-200">
          <Search className="w-3.5 h-3.5 text-neutral-400" />
          <input className="text-[13px] outline-none w-40" placeholder="搜索标题 / 描述" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as IssueStatus | '')}>
          <option value="">全部状态</option>
          {(Object.keys(STATUS_LABEL) as IssueStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select className={selectCls} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">全部类型</option>
          {withSubTags(categories).map(({ tag, depth }) => (
            <option key={tag.id} value={tag.id}>{depth ? `${categories.find((p) => p.id === tag.parentId)?.name}-${tag.name}` : tag.name}</option>
          ))}
        </select>
        <select className={selectCls} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">全部区域</option>
          {locations.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select className={selectCls} value={reviewed} onChange={(e) => setReviewed(e.target.value as '' | 'unreviewed' | 'reviewed')}>
          <option value="">全部复核状态</option>
          <option value="unreviewed">人工未复核</option>
          <option value="reviewed">人工已复核</option>
        </select>
        {/* 发现时间范围：ISO 日期前 10 位字典序比较，前后都含当天 */}
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white border border-neutral-200">
          <span className="text-[12px] text-neutral-400 shrink-0">发现时间</span>
          <input type="date" className="text-[13px] outline-none bg-transparent" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <span className="text-neutral-300 text-[12px]">至</span>
          <input type="date" className="text-[13px] outline-none bg-transparent" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(''); setDateTo('') }} className="text-[12px] text-neutral-400 hover:text-[#D70015]" title="清除时间筛选">
              ×
            </button>
          )}
        </div>
        {/* 排序切换：默认发现日期倒序，可切录入日期倒序 */}
        <select className={selectCls} value={sortBy} onChange={(e) => setSortBy(e.target.value as 'foundAt' | 'createdAt')} title="列表排序方式">
          <option value="foundAt">按发现日期</option>
          <option value="createdAt">按录入日期</option>
        </select>
      </div>

      {/* 列表 */}
      <div className="bg-white rounded-2xl shadow-sm divide-y divide-neutral-100">
        {filtered.length === 0 && <p className="text-center text-[13px] text-neutral-400 py-10">没有匹配的隐患记录</p>}
        {pageItems.map((i) => (
          <div key={i.id} className="p-4 flex items-start gap-4">
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => openDetail(i)}
                  className="text-[15px] font-medium text-left hover:text-[#007AFF] transition-colors cursor-pointer"
                  title="查看详情"
                >
                  {i.title}
                </button>
                {i.scope === 'reference' && (
                  <span className="px-2 py-0.5 rounded-md text-[12px] font-medium bg-neutral-500/10 text-neutral-500">参考</span>
                )}
                {i.isGood && (
                  <span className="px-2 py-0.5 rounded-md text-[12px] font-medium bg-[#34C759]/12 text-[#248A3D]" title="正面典型：不计入整改闭环与超期提醒，已沉淀到知识库「好做法」">
                    做得好
                  </span>
                )}
                {/* 参考件标注徽标：已评估参考意义的直接显示等级 */}
                {i.scope === 'reference' && (() => {
                  const ann = annotations.find((a) => a.issueId === i.id)
                  if (!ann) return null
                  const badge = RELEVANCE_BADGE[ann.relevance]
                  return (
                    <span
                      className={`px-2 py-0.5 rounded-md text-[12px] font-medium ${badge.cls}`}
                      title={[ann.similarity && `相似点：${ann.similarity}`, ann.caution && `注意：${ann.caution}`].filter(Boolean).join('\n') || undefined}
                    >
                      {badge.label}
                    </span>
                  )
                })()}
                <RiskBadge level={i.riskLevel} />
                {i.reviewed === false && (
                  <span className="px-2 py-0.5 rounded-md text-[12px] font-medium bg-[#FF9500]/12 text-[#B25000]" title="批量识别导入，尚未人工复核">
                    未复核
                  </span>
                )}
                <StatusBadge status={i.status} overdue={isOverdue(i)} />
                {/* 网格责任人重复提醒：2 次橙色提醒，≥3 次红色严重提醒（加倍考核） */}
                {i.gridOwner && (() => {
                  const count = gridOwnerCounts.get(i.gridOwner.trim()) ?? 0
                  const tier = gridOwnerTier(count)
                  if (!tier) return null
                  return (
                    <span
                      className={`px-2 py-0.5 rounded-md text-[12px] font-medium ${
                        tier === 'severe' ? 'bg-[#FF3B30] text-white' : 'bg-[#FF9500]/12 text-[#B25000]'
                      }`}
                      title={`网格责任人「${i.gridOwner.trim()}」已在 ${count} 条成品车间隐患中重复出现${tier === 'severe' ? '，建议加倍考核并专项排查' : '，请关注'}`}
                    >
                      {tier === 'severe' ? `严重重复 ×${count} · 加倍考核` : `责任人重复 ×${count}`}
                    </span>
                  )
                })()}
                <span className="text-[11px] text-neutral-400">{SOURCE_LABEL[i.source]}</span>
              </div>
              {i.description && <p className="text-[13px] text-neutral-500 line-clamp-1">{i.description}</p>}
              <div className="text-[12px] text-neutral-400 flex gap-3 flex-wrap">
                <span>发现 {fmtDate(i.foundAt)}</span>
                <span>录入 {fmtDate(i.createdAt)}</span>
                {i.deadline && <span>期限 {fmtDate(i.deadline)}</span>}
                {tagName(i.categoryId) && <span>类型 · {tagName(i.categoryId)}</span>}
                {tagName(i.locationId) && <span>区域 · {tagName(i.locationId)}</span>}
                {i.assignee && <span>责任人 · {i.assignee}</span>}
              </div>
              {/* 照片缩略图（无照片时保留补传入口） */}
              <div className="flex gap-1.5 flex-wrap pt-1">
                {(i.photos ?? []).map((p, idx) => (
                  <button key={p} onClick={() => setLightbox({ issueId: i.id, index: idx })} className="w-14 h-14 rounded-lg overflow-hidden bg-neutral-100 shrink-0">
                    <img src={p} alt="" className="w-full h-full object-cover" loading="lazy" />
                  </button>
                ))}
                {(i.photos?.length ?? 0) < 9 && (
                  <button
                    onClick={() => { setPhotoTargetId(i.id); photoInputRef.current?.click() }}
                    title="补传现场/整改照片"
                    className="w-14 h-14 rounded-lg border border-dashed border-neutral-200 flex items-center justify-center text-neutral-300 hover:border-[#007AFF]/50 hover:text-[#007AFF] transition-colors shrink-0"
                  >
                    <ImagePlus className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {i.reviewed === false && (
                <button
                  onClick={() => updateIssue(i.id, { reviewed: true })}
                  title="人工复核无误后标记"
                  className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-[#FF9500]/12 text-[#B25000] text-[12px] font-medium hover:bg-[#FF9500]/25 transition-colors"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  标记已复核
                </button>
              )}
              {/* 参考件/正面典型不进入整改闭环，不显示状态流转按钮 */}
              {i.scope !== 'reference' && !i.isGood && NEXT_ACTION[i.status] && (
                <button
                  onClick={() => transition(i)}
                  className="px-3.5 py-1.5 rounded-full bg-[#007AFF] text-white text-[12px] font-medium hover:bg-[#0066D6] transition-colors"
                >
                  {NEXT_ACTION[i.status]!.label}
                </button>
              )}
              <button
                onClick={() => confirmRemove(i)}
                className={
                  pendingDeleteId === i.id
                    ? 'px-2.5 py-1 rounded-full bg-[#FF3B30] text-white text-[11px] font-medium'
                    : 'p-1.5 text-neutral-300 hover:text-[#FF3B30] transition-colors'
                }
              >
                {pendingDeleteId === i.id ? '确认删除' : <Trash2 className="w-4 h-4" />}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 分页控制：库内记录多时只渲染当前页 */}
      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => setPage(curPage - 1)}
            disabled={curPage === 0}
            className="px-3 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] text-neutral-600 hover:bg-neutral-50 transition-colors disabled:opacity-30"
          >
            上一页
          </button>
          <span className="text-[13px] text-neutral-500">
            第 {curPage + 1} / {pageCount} 页 · 本页 {pageItems.length} 条 / 共 {filtered.length} 条
          </span>
          <button
            onClick={() => setPage(curPage + 1)}
            disabled={curPage >= pageCount - 1}
            className="px-3 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] text-neutral-600 hover:bg-neutral-50 transition-colors disabled:opacity-30"
          >
            下一页
          </button>
        </div>
      )}

      {/* 补传照片的隐藏文件选择器 */}
      <input
        ref={photoInputRef} type="file" accept="image/*" multiple className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (photoTargetId) addPhotosTo(photoTargetId, files)
          setPhotoTargetId(null)
          e.target.value = ''
        }}
      />

      {/* 详情弹层（z-40，大图 lightbox 在其上层） */}
      {detailIssue && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={closeDetail}>
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[85vh] overflow-y-auto p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 头部：标题 + 徽标 + 关闭 */}
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-2 min-w-0 flex-1">
                {editing ? (
                  <input
                    className="w-full px-3 py-2 rounded-lg bg-neutral-100/80 text-[16px] font-semibold outline-none focus:ring-2 ring-[#007AFF]/30"
                    value={editForm.title}
                    onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                  />
                ) : (
                  <h2 className="text-[18px] font-semibold leading-snug">{detailIssue.title}</h2>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  {detailIssue.scope === 'reference' && (
                    <span className="px-2 py-0.5 rounded-md text-[12px] font-medium bg-neutral-500/10 text-neutral-500">参考</span>
                  )}
                  {detailIssue.isGood && (
                    <span className="px-2 py-0.5 rounded-md text-[12px] font-medium bg-[#34C759]/12 text-[#248A3D]">做得好</span>
                  )}
                  <RiskBadge level={detailIssue.riskLevel} />
                  {detailIssue.reviewed === false && (
                    <button
                      onClick={() => updateIssue(detailIssue.id, { reviewed: true })}
                      title="批量识别导入，人工复核无误后点击标记"
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] font-medium bg-[#FF9500]/12 text-[#B25000] hover:bg-[#FF9500]/25 transition-colors"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      未复核 · 点击标记已复核
                    </button>
                  )}
                  <StatusBadge status={detailIssue.status} overdue={isOverdue(detailIssue)} />
                  <span className="text-[11px] text-neutral-400">{SOURCE_LABEL[detailIssue.source]}</span>
                </div>
              </div>
              <button onClick={closeDetail} className="p-1.5 text-neutral-400 hover:text-neutral-700 transition-colors shrink-0">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 完整描述 */}
            {editing ? (
              <textarea
                className="w-full px-3 py-2 rounded-lg bg-neutral-100/80 text-[14px] outline-none focus:ring-2 ring-[#007AFF]/30 min-h-24"
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                placeholder="问题描述"
              />
            ) : (
              detailIssue.description && (
                <p className="text-[14px] text-neutral-600 leading-relaxed whitespace-pre-wrap">{detailIssue.description}</p>
              )
            )}

            {/* 信息栏 / 编辑表单 */}
            {editing ? (
              <div className="grid grid-cols-2 gap-3 bg-neutral-50 rounded-xl p-4">
                <label className="space-y-1">
                  <span className="text-neutral-400 text-[12px]">隐患类型</span>
                  <select className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none" value={editForm.categoryId} onChange={(e) => setEditForm({ ...editForm, categoryId: e.target.value })}>
                    <option value="">未分类</option>
                    {withSubTags(categories).map(({ tag, depth }) => (
                      <option key={tag.id} value={tag.id}>{depth ? `${categories.find((p) => p.id === tag.parentId)?.name}-${tag.name}` : tag.name}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-neutral-400 text-[12px]">所在区域</span>
                  <select className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none" value={editForm.locationId} onChange={(e) => setEditForm({ ...editForm, locationId: e.target.value })}>
                    <option value="">未指定</option>
                    {locations.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-neutral-400 text-[12px]">风险等级</span>
                  <select className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none" value={editForm.riskLevel} onChange={(e) => setEditForm({ ...editForm, riskLevel: e.target.value as SafetyIssue['riskLevel'] })}>
                    {(['immediate', 'general', 'critical'] as const).map((r) => <option key={r} value={r}>{RISK_LABEL[r]}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-neutral-400 text-[12px]">整改期限</span>
                  <input type="date" className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none" value={editForm.deadline} onChange={(e) => setEditForm({ ...editForm, deadline: e.target.value })} />
                </label>
                <label className="space-y-1 col-span-2">
                  <span className="text-neutral-400 text-[12px]">整改责任人</span>
                  <input className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none" value={editForm.assignee} onChange={(e) => setEditForm({ ...editForm, assignee: e.target.value })} />
                </label>
                <label className="space-y-1">
                  <span className="text-neutral-400 text-[12px]">责任班组</span>
                  <select className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none" value={editForm.team} onChange={(e) => setEditForm({ ...editForm, team: e.target.value })}>
                    <option value="">未指定</option>
                    {TEAMS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-neutral-400 text-[12px]">网格主操手</span>
                  <input className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none" value={editForm.gridOperator} onChange={(e) => setEditForm({ ...editForm, gridOperator: e.target.value })} />
                </label>
                <label className="space-y-1">
                  <span className="text-neutral-400 text-[12px]">网格责任人</span>
                  <input className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none" value={editForm.gridOwner} onChange={(e) => setEditForm({ ...editForm, gridOwner: e.target.value })} />
                  {editForm.gridOwner.trim() && (gridOwnerCounts.get(editForm.gridOwner.trim()) ?? 0) >= 1 && editForm.gridOwner.trim() !== (detailIssue.gridOwner ?? '') && (
                    <span className="text-[11px] text-[#D70015]">
                      该责任人已在其他 {gridOwnerCounts.get(editForm.gridOwner.trim())} 条隐患中出现
                      {(gridOwnerCounts.get(editForm.gridOwner.trim()) ?? 0) >= 2 ? '，保存后将达 3 次以上，升级为严重提醒（加倍考核）' : '，保存后将触发重复提醒'}
                    </span>
                  )}
                </label>
                <label className="space-y-1">
                  <span className="text-neutral-400 text-[12px]">系统责任人</span>
                  <input className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none" value={editForm.systemOwner} onChange={(e) => setEditForm({ ...editForm, systemOwner: e.target.value })} />
                </label>
                <label className="space-y-1 col-span-2">
                  <span className="text-neutral-400 text-[12px]">系统原因</span>
                  <textarea className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none min-h-14" value={editForm.systemCause} onChange={(e) => setEditForm({ ...editForm, systemCause: e.target.value })} placeholder="管理、制度、流程层面的根因分析…" />
                </label>
                {/* 戴明 94/6 根因类别：先问机制，再问人 */}
                <label className="space-y-1">
                  <span className="text-neutral-400 text-[12px]">根因类别</span>
                  <select
                    className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none"
                    value={editForm.causeType}
                    onChange={(e) => {
                      const v = e.target.value as '' | CauseType
                      setEditForm({ ...editForm, causeType: v, countermeasureLevel: v === 'system' ? editForm.countermeasureLevel : '' })
                    }}
                  >
                    <option value="">未判定</option>
                    <option value="system">{CAUSE_TYPE_LABEL.system}</option>
                    <option value="individual">{CAUSE_TYPE_LABEL.individual}</option>
                  </select>
                </label>
                {editForm.causeType === 'system' && (
                  <label className="space-y-1">
                    <span className="text-neutral-400 text-[12px]">对策层级（机制 → 技术 → 管理）</span>
                    <select
                      className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none"
                      value={editForm.countermeasureLevel}
                      onChange={(e) => setEditForm({ ...editForm, countermeasureLevel: e.target.value as '' | CountermeasureLevel })}
                    >
                      <option value="">未选择</option>
                      {(['mechanism', 'technical', 'management'] as CountermeasureLevel[]).map((lv) => (
                        <option key={lv} value={lv}>{COUNTERMEASURE_LABEL[lv]}</option>
                      ))}
                    </select>
                  </label>
                )}
                {editForm.causeType === 'system' && editForm.countermeasureLevel === 'management' && (
                  <label className="space-y-1 col-span-2">
                    <span className="text-neutral-400 text-[12px]">为什么机制和技术做不到？*</span>
                    <textarea
                      className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none min-h-14"
                      value={editForm.countermeasureReason}
                      onChange={(e) => setEditForm({ ...editForm, countermeasureReason: e.target.value })}
                      placeholder="说明为何无法靠机制或技术解决，只能靠管理手段…"
                    />
                    {editReasonMissing && <span className="text-[11px] text-[#D70015]">选「管理」必须填写理由，否则不能保存</span>}
                  </label>
                )}
                <label className="space-y-1 col-span-2">
                  <span className="text-neutral-400 text-[12px]">整改记录</span>
                  <textarea className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none min-h-16" value={editForm.fixNote} onChange={(e) => setEditForm({ ...editForm, fixNote: e.target.value })} placeholder="选填" />
                </label>
              </div>
            ) : (
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 text-[13px] bg-neutral-50 rounded-xl p-4">
              <div><dt className="text-neutral-400 text-[12px]">发现时间</dt><dd className="mt-0.5">{fmtDateTime(detailIssue.foundAt)}</dd></div>
              <div><dt className="text-neutral-400 text-[12px]">录入时间</dt><dd className="mt-0.5">{fmtDateTime(detailIssue.createdAt)}</dd></div>
              {detailIssue.deadline && <div><dt className="text-neutral-400 text-[12px]">整改期限</dt><dd className="mt-0.5">{fmtDate(detailIssue.deadline)}</dd></div>}
              {detailIssue.closedAt && <div><dt className="text-neutral-400 text-[12px]">闭环时间</dt><dd className="mt-0.5">{fmtDateTime(detailIssue.closedAt)}</dd></div>}
              {tagName(detailIssue.categoryId) && <div><dt className="text-neutral-400 text-[12px]">隐患类型</dt><dd className="mt-0.5">{tagName(detailIssue.categoryId)}</dd></div>}
              {tagName(detailIssue.locationId) && <div><dt className="text-neutral-400 text-[12px]">所在区域</dt><dd className="mt-0.5">{tagName(detailIssue.locationId)}</dd></div>}
              <div><dt className="text-neutral-400 text-[12px]">风险等级</dt><dd className="mt-0.5">{RISK_LABEL[detailIssue.riskLevel]}</dd></div>
              {detailIssue.assignee && <div><dt className="text-neutral-400 text-[12px]">整改责任人</dt><dd className="mt-0.5">{detailIssue.assignee}</dd></div>}
              {detailIssue.team && <div><dt className="text-neutral-400 text-[12px]">责任班组</dt><dd className="mt-0.5">{detailIssue.team}</dd></div>}
              {detailIssue.gridOperator && <div><dt className="text-neutral-400 text-[12px]">网格主操手</dt><dd className="mt-0.5">{detailIssue.gridOperator}</dd></div>}
              {detailIssue.gridOwner && (
                <div>
                  <dt className="text-neutral-400 text-[12px]">网格责任人</dt>
                  {(() => {
                    const count = gridOwnerCounts.get(detailIssue.gridOwner.trim()) ?? 0
                    const tier = gridOwnerTier(count)
                    return (
                      <dd className={`mt-0.5 ${tier === 'severe' ? 'text-[#D70015] font-semibold' : tier === 'warn' ? 'text-[#B25000] font-medium' : ''}`}>
                        {detailIssue.gridOwner}
                        {tier === 'severe' && `（严重重复 ×${count}）`}
                        {tier === 'warn' && `（重复 ×${count}）`}
                      </dd>
                    )
                  })()}
                </div>
              )}
              {detailIssue.systemOwner && <div><dt className="text-neutral-400 text-[12px]">系统责任人</dt><dd className="mt-0.5">{detailIssue.systemOwner}</dd></div>}
              {detailIssue.causeType && (
                <div>
                  <dt className="text-neutral-400 text-[12px]">根因类别</dt>
                  <dd className="mt-0.5">
                    {CAUSE_TYPE_LABEL[detailIssue.causeType]}
                    {detailIssue.causeType === 'system' && detailIssue.countermeasureLevel && ` · 对策：${COUNTERMEASURE_LABEL[detailIssue.countermeasureLevel]}`}
                  </dd>
                </div>
              )}
              {detailIssue.reporter && <div><dt className="text-neutral-400 text-[12px]">排查人</dt><dd className="mt-0.5">{detailIssue.reporter}</dd></div>}
              {detailIssue.sourceFile && <div className="col-span-2 sm:col-span-3"><dt className="text-neutral-400 text-[12px]">来源文件</dt><dd className="mt-0.5 break-all">{detailIssue.sourceFile}</dd></div>}
            </dl>
            )}

            {/* AI 原判对照：AI 预填与人工最终字段不一致时提示（原则二：人工确认才算数） */}
            {!editing && (() => {
              const diffs: string[] = []
              const humanCat = tagName(detailIssue.categoryId)
              // 子标签 AI 可能只回原名，人工名以其结尾也算一致，避免误报
              if (detailIssue.aiCategory && !(humanCat === detailIssue.aiCategory || humanCat?.endsWith(`-${detailIssue.aiCategory}`))) {
                diffs.push(`类型 ${detailIssue.aiCategory}`)
              }
              if (detailIssue.aiRiskLevel && detailIssue.aiRiskLevel !== detailIssue.riskLevel) {
                diffs.push(`等级 ${RISK_LABEL[detailIssue.aiRiskLevel] ?? detailIssue.aiRiskLevel}`)
              }
              if (detailIssue.aiCauseType && detailIssue.aiCauseType !== detailIssue.causeType) {
                diffs.push(`根因 ${CAUSE_TYPE_LABEL[detailIssue.aiCauseType] ?? detailIssue.aiCauseType}`)
              }
              if (!diffs.length && !detailIssue.aiSuggestion) return null
              return (
                <p className="text-[11px] text-neutral-400 leading-relaxed">
                  {diffs.length > 0 && <>AI 原判：{diffs.join('、')}，人工已修正。</>}
                  {detailIssue.aiSuggestion && <>AI 整改建议：{detailIssue.aiSuggestion}</>}
                </p>
              )
            })()}

            {/* 系统原因 */}
            {!editing && detailIssue.systemCause && (
              <div className="rounded-xl bg-[#5856D6]/6 border border-[#5856D6]/15 p-3.5">
                <div className="text-[12px] text-[#5856D6] font-medium mb-1">系统原因</div>
                <p className="text-[13px] text-neutral-600 leading-relaxed whitespace-pre-wrap">{detailIssue.systemCause}</p>
              </div>
            )}

            {/* 选「管理」对策的理由（为什么机制和技术做不到） */}
            {!editing && detailIssue.causeType === 'system' && detailIssue.countermeasureLevel === 'management' && detailIssue.countermeasureReason && (
              <div className="rounded-xl bg-[#FF9500]/8 border border-[#FF9500]/20 p-3.5">
                <div className="text-[12px] text-[#B25000] font-medium mb-1">选「管理」对策的理由</div>
                <p className="text-[13px] text-neutral-600 leading-relaxed whitespace-pre-wrap">{detailIssue.countermeasureReason}</p>
              </div>
            )}

            {/* 法规依据：只读列出关联法规；编辑模式可搜索添加 / 移除 */}
            <div className="rounded-xl bg-neutral-50 p-4 space-y-2.5">
              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                <BookMarked className="w-4 h-4 text-[#007AFF]" />
                法规依据（{(detailIssue.regulations ?? []).length}）
              </div>
              {(detailIssue.regulations ?? []).length === 0 && !editing && (
                <p className="text-[12px] text-neutral-400">尚未关联法规依据，点「编辑」可添加</p>
              )}
              {(detailIssue.regulations ?? []).length > 0 && (
                <ul className="space-y-1.5">
                  {(detailIssue.regulations ?? []).map((r) => {
                    const meta = REG_CATEGORY_META[r.category] ?? { label: r.category, cls: 'bg-neutral-100 text-neutral-500' }
                    return (
                      <li key={r.id} className="flex items-start gap-2 rounded-lg bg-white border border-neutral-200 px-3 py-2">
                        <span className={`shrink-0 mt-0.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] text-neutral-800 leading-snug">
                            {r.title}
                            {r.articleNo && <span className="ml-1.5 text-[12px] text-neutral-400">{r.articleNo}</span>}
                          </div>
                          {r.summary && <p className="text-[12px] text-neutral-400 leading-relaxed line-clamp-2">{r.summary}</p>}
                        </div>
                        {editing && (
                          <button
                            onClick={() => unlinkRegulation(detailIssue.id, r.id)}
                            title="移除该法规依据"
                            className="shrink-0 p-1 text-neutral-300 hover:text-[#FF3B30] transition-colors"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              {editing && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 rounded-lg bg-white border border-neutral-200 px-3 py-1.5">
                    <Search className="w-3.5 h-3.5 text-neutral-400" />
                    <input
                      className="flex-1 text-[13px] outline-none"
                      placeholder="搜索法规名称 / 关键词…"
                      value={regQ}
                      onChange={(e) => setRegQ(e.target.value)}
                    />
                  </div>
                  <div className="max-h-44 overflow-y-auto space-y-1">
                    {regSearching && <p className="text-[12px] text-neutral-400 px-1 py-1">搜索中…</p>}
                    {!regSearching && regResults
                      .filter((r) => !(detailIssue.regulations ?? []).some((x) => x.id === r.id))
                      .slice(0, 20)
                      .map((r) => {
                        const meta = REG_CATEGORY_META[r.category] ?? { label: r.category, cls: 'bg-neutral-100 text-neutral-500' }
                        return (
                          <div key={r.id} className="flex items-center gap-2 rounded-lg bg-white border border-neutral-200 px-3 py-1.5">
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>
                            <span className="flex-1 min-w-0 truncate text-[13px] text-neutral-700">{r.title}</span>
                            <button
                              onClick={() => linkRegulation(detailIssue.id, r.id)}
                              className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#007AFF]/10 text-[#007AFF] text-[12px] font-medium hover:bg-[#007AFF]/18 transition-colors"
                            >
                              <Plus className="w-3 h-3" />
                              添加
                            </button>
                          </div>
                        )
                      })}
                    {!regSearching && regResults.filter((r) => !(detailIssue.regulations ?? []).some((x) => x.id === r.id)).length === 0 && (
                      <p className="text-[12px] text-neutral-400 px-1 py-1">没有可添加的法规条目</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 整改闭环阶段：复查中 → 制度沉淀 → 教育职工 → 规范执行 → 闭环完成（顺序锁定，仅当前阶段可完成） */}
            {!editing && detailIssue.scope !== 'reference' && !detailIssue.isGood && (
              <div className="rounded-xl bg-neutral-50 p-4 space-y-3">
                <div className="text-[13px] font-medium">整改闭环阶段</div>
                <ol className="flex items-center gap-1.5">
                  {STAGE_ORDER.map((s, idx) => {
                    const cur = STAGE_ORDER.indexOf(detailIssue.stage ?? 'rechecking')
                    const state = idx < cur ? 'done' : idx === cur ? 'current' : 'todo'
                    return (
                      <li key={s} className="flex items-center gap-1.5 flex-1 last:flex-none min-w-0">
                        <div className={`flex items-center gap-1 shrink-0 ${state === 'current' ? 'text-[#007AFF]' : state === 'done' ? 'text-[#34C759]' : 'text-neutral-300'}`}>
                          {state === 'done' ? <CheckCircle2 className="w-4 h-4" /> : <Circle className={`w-4 h-4 ${state === 'current' ? 'fill-[#007AFF]/20' : ''}`} />}
                          <span className={`text-[12px] whitespace-nowrap ${state === 'current' ? 'font-semibold' : ''}`}>{STAGE_LABEL[s]}</span>
                        </div>
                        {idx < STAGE_ORDER.length - 1 && <div className={`h-px flex-1 min-w-2 ${idx < cur ? 'bg-[#34C759]/40' : 'bg-neutral-200'}`} />}
                      </li>
                    )
                  })}
                </ol>

                {/* 制度沉淀完成表单：制度要点 + 可选知识库条目 */}
                {detailIssue.stage === 'institutionalizing' ? (
                  <div className="space-y-2.5">
                    <textarea
                      className="w-full px-3 py-2 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none min-h-16 focus:ring-2 ring-[#007AFF]/30"
                      value={institutionDraft.note}
                      onChange={(e) => setInstitutionDraft({ ...institutionDraft, note: e.target.value })}
                      placeholder="制度要点：把本次整改的要求写进制度/规程/点检表…"
                    />
                    <select
                      className="w-full px-3 py-2 rounded-lg bg-white border border-neutral-200 text-[13px] outline-none"
                      value={institutionDraft.docId}
                      onChange={(e) => setInstitutionDraft({ ...institutionDraft, docId: e.target.value })}
                    >
                      <option value="">关联知识库条目（选填）</option>
                      {knowledgeDocs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                    </select>
                    <button
                      onClick={() => advanceStage(detailIssue.id, { note: institutionDraft.note, linkedKnowledgeDocId: institutionDraft.docId || undefined })}
                      className="px-4 py-1.5 rounded-full bg-[#007AFF] text-white text-[12px] font-medium hover:bg-[#0066D6] transition-colors"
                    >
                      完成本阶段（制度沉淀）
                    </button>
                  </div>
                ) : detailIssue.stage === 'rechecking' ? (
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={() => advanceStage(detailIssue.id)}
                      disabled={(detailIssue.rechecks ?? []).length < (detailIssue.recheckRequired ?? 3)}
                      title="复查全部合格后才能进入制度沉淀"
                      className="px-4 py-1.5 rounded-full bg-[#007AFF] text-white text-[12px] font-medium hover:bg-[#0066D6] transition-colors disabled:opacity-40"
                    >
                      完成本阶段（复查中）
                    </button>
                    <span className="text-[12px] text-neutral-400">复查全部合格后进入「制度沉淀」；复查不合格会自动顺延一次复查</span>
                  </div>
                ) : detailIssue.stage === 'done' ? (
                  <p className="text-[12px] text-[#248A3D]">整改闭环已完成</p>
                ) : (
                  <button
                    onClick={() => advanceStage(detailIssue.id)}
                    className="px-4 py-1.5 rounded-full bg-[#007AFF] text-white text-[12px] font-medium hover:bg-[#0066D6] transition-colors"
                  >
                    完成本阶段（{STAGE_LABEL[detailIssue.stage ?? 'rechecking']}）
                  </button>
                )}

                {/* 制度沉淀记录展示（完成制度沉淀后各阶段可见） */}
                {detailIssue.institutionNote && STAGE_ORDER.indexOf(detailIssue.stage ?? 'rechecking') > 1 && (
                  <div className="rounded-lg bg-white border border-neutral-200 px-3 py-2 text-[12px] text-neutral-500 space-y-0.5">
                    <div className="text-neutral-400">制度要点</div>
                    <p className="whitespace-pre-wrap">{detailIssue.institutionNote}</p>
                    {detailIssue.linkedKnowledgeDocId && (
                      <p className="text-[#007AFF]">已关联知识库条目：{knowledgeDocs.find((d) => d.id === detailIssue.linkedKnowledgeDocId)?.title ?? detailIssue.linkedKnowledgeDocId}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 网格责任人重复提醒：2 次橙色提醒，≥3 次红色严重提醒（加倍考核） */}
            {!editing && detailIssue.gridOwner && (() => {
              const count = gridOwnerCounts.get(detailIssue.gridOwner.trim()) ?? 0
              const tier = gridOwnerTier(count)
              if (!tier) return null
              return tier === 'severe' ? (
                <div className="rounded-xl bg-[#FF3B30]/8 border border-[#FF3B30]/25 p-3.5 text-[13px] text-[#D70015] leading-relaxed">
                  <span className="font-semibold">严重提醒：</span>
                  网格责任人「{detailIssue.gridOwner.trim()}」已在 {count} 条成品车间隐患中重复出现（≥3 次），建议加倍考核，并对其负责网格开展专项排查与原因分析。
                </div>
              ) : (
                <div className="rounded-xl bg-[#FF9500]/8 border border-[#FF9500]/25 p-3.5 text-[13px] text-[#B25000] leading-relaxed">
                  网格责任人「{detailIssue.gridOwner.trim()}」已在 {count} 条成品车间隐患中重复出现，请关注；若达到 3 次将升级为严重提醒（加倍考核）。
                </div>
              )
            })()}

            {/* 整改记录 */}
            {!editing && detailIssue.fixNote && (
              <div className="rounded-xl bg-[#34C759]/8 border border-[#34C759]/15 p-3.5">
                <div className="text-[12px] text-[#248A3D] font-medium mb-1">整改记录</div>
                <p className="text-[13px] text-neutral-600 leading-relaxed">{detailIssue.fixNote}</p>
              </div>
            )}

            {/* 防复发复查：成品车间隐患至少 N 次，间隔可编辑（默认 7 天）；正面典型不走闭环 */}
            {!editing && detailIssue.scope !== 'reference' && !detailIssue.isGood && (
              <div className="rounded-xl bg-neutral-50 p-4 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium">
                    防复发复查（{(detailIssue.rechecks ?? []).length} / {detailIssue.recheckRequired ?? 3}）
                  </span>
                  <label className="flex items-center gap-1.5 text-[12px] text-neutral-400">
                    间隔
                    <input
                      type="number" min={1}
                      className="w-14 px-2 py-1 rounded-md bg-white border border-neutral-200 text-[12px] outline-none text-center"
                      value={intervalDraft}
                      onChange={(e) => setIntervalDraft(e.target.value)}
                      onBlur={saveInterval}
                    />
                    天
                  </label>
                </div>
                <ul className="space-y-1.5">
                  {Array.from({ length: detailIssue.recheckRequired ?? 3 }, (_, n) => n + 1).map((n) => {
                    const rechecks = detailIssue.rechecks ?? []
                    const doneAt = rechecks[n - 1]
                    const dueMs = new Date(detailIssue.foundAt).getTime() + n * (detailIssue.recheckIntervalDays ?? 7) * 86_400_000
                    const overdueRecheck = !doneAt && dueMs <= Date.now()
                    const isNext = !doneAt && n === rechecks.length + 1
                    return (
                      <li key={n} className="flex items-center gap-2 text-[13px]">
                        {doneAt
                          ? <CheckCircle2 className="w-4 h-4 text-[#34C759] shrink-0" />
                          : <Circle className={`w-4 h-4 shrink-0 ${overdueRecheck ? 'text-[#FF9500]' : 'text-neutral-300'}`} />}
                        <span className={doneAt ? 'text-neutral-400' : ''}>第 {n} 次</span>
                        <span className={`text-[12px] ${overdueRecheck ? 'text-[#FF9500]' : 'text-neutral-400'}`}>
                          {doneAt ? `已完成 ${fmtDateTime(doneAt)}` : `应查 ${fmtDate(new Date(dueMs).toISOString())}${overdueRecheck ? ' · 已到期' : ''}`}
                        </span>
                        {isNext && (
                          <span className="ml-auto flex items-center gap-2">
                            <button
                              onClick={() => recheckIssue(detailIssue.id, true)}
                              title="复发顺延：要求复查次数 +1，保持复查中阶段"
                              className="flex items-center gap-1 px-3 py-1 rounded-full bg-[#FF3B30]/10 text-[#D70015] text-[12px] font-medium hover:bg-[#FF3B30]/20 transition-colors"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              不合格·复发
                            </button>
                            <button
                              onClick={() => recheckIssue(detailIssue.id)}
                              className="px-3 py-1 rounded-full bg-[#34C759] text-white text-[12px] font-medium hover:bg-[#2DB34E] transition-colors"
                            >
                              完成本次复查
                            </button>
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            {/* 照片 */}
            <div>
              <div className="text-[12px] text-neutral-400 mb-1.5">照片（{(detailIssue.photos ?? []).length} / 9）</div>
              <div className="flex gap-1.5 flex-wrap">
                {(detailIssue.photos ?? []).map((p, idx) => (
                  <button key={p} onClick={() => setLightbox({ issueId: detailIssue.id, index: idx })} className="w-16 h-16 rounded-lg overflow-hidden bg-neutral-100 shrink-0">
                    <img src={p} alt="" className="w-full h-full object-cover" loading="lazy" />
                  </button>
                ))}
                {(detailIssue.photos?.length ?? 0) < 9 && (
                  <button
                    onClick={() => { setPhotoTargetId(detailIssue.id); photoInputRef.current?.click() }}
                    title="补传现场/整改照片"
                    className="w-16 h-16 rounded-lg border border-dashed border-neutral-200 flex items-center justify-center text-neutral-300 hover:border-[#007AFF]/50 hover:text-[#007AFF] transition-colors shrink-0"
                  >
                    <ImagePlus className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* 操作 */}
            {editing ? (
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => setEditing(false)}
                  className="px-4 py-1.5 rounded-full text-[13px] text-neutral-500 hover:bg-neutral-100 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={saveEdit}
                  disabled={!editForm.title.trim() || editReasonMissing}
                  className="px-4 py-1.5 rounded-full bg-[#007AFF] text-white text-[13px] font-medium hover:bg-[#0066D6] transition-colors disabled:opacity-40"
                >
                  保存修改
                </button>
              </div>
            ) : (
            <div className="flex items-center justify-end gap-2 pt-1">
              {/* 好做法切换：正面典型沉淀到知识库，取消标记则移除 */}
              <button
                onClick={() => updateIssue(detailIssue.id, { isGood: !detailIssue.isGood })}
                title={detailIssue.isGood ? '取消后将从知识库「好做法」移除' : '标记为正面典型，自动沉淀到知识库「好做法」'}
                className={`mr-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                  detailIssue.isGood
                    ? 'bg-[#34C759] text-white hover:bg-[#2DB34E]'
                    : 'text-[#248A3D] border border-[#34C759]/40 hover:bg-[#34C759]/8'
                }`}
              >
                <ThumbsUp className="w-3.5 h-3.5" />
                {detailIssue.isGood ? '已标为好做法 · 点击取消' : '标为好做法'}
              </button>
              {/* AI 范例学习：已复核且已分类的隐患设为范例，预标注提示词按此口径对齐 */}
              {detailIssue.reviewed !== false && detailIssue.categoryId && (
                <button
                  onClick={() => setAsExample(detailIssue)}
                  disabled={exampleSaving || exampleSaved}
                  title="把这条人工确认的分类设为 AI 范例：下次预标注时每类取最近 3 条范例对齐口径"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium text-[#007AFF] border border-[#007AFF]/40 hover:bg-[#007AFF]/8 transition-colors disabled:opacity-50"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {exampleSaved ? '已设为 AI 范例' : exampleSaving ? '保存中…' : '设为 AI 范例'}
                </button>
              )}
              {exampleError && <span className="text-[11px] text-[#D70015]">{exampleError}</span>}
              <button
                onClick={() => startEdit(detailIssue)}
                className="px-3 py-1.5 rounded-full text-[#007AFF] text-[12px] hover:bg-[#007AFF]/8 transition-colors"
              >
                编辑
              </button>
              <button
                onClick={() => confirmRemove(detailIssue)}
                className={
                  pendingDeleteId === detailIssue.id
                    ? 'px-3 py-1.5 rounded-full bg-[#FF3B30] text-white text-[12px] font-medium'
                    : 'px-3 py-1.5 rounded-full text-[#FF3B30] text-[12px] hover:bg-[#FF3B30]/8 transition-colors flex items-center gap-1.5'
                }
              >
                {pendingDeleteId === detailIssue.id ? '确认删除' : <><Trash2 className="w-3.5 h-3.5" />删除</>}
              </button>
              {detailIssue.scope !== 'reference' && !detailIssue.isGood && NEXT_ACTION[detailIssue.status] && (
                <button
                  onClick={() => transition(detailIssue)}
                  className="px-4 py-1.5 rounded-full bg-[#007AFF] text-white text-[13px] font-medium hover:bg-[#0066D6] transition-colors"
                >
                  {NEXT_ACTION[detailIssue.status]!.label}
                </button>
              )}
            </div>
            )}
          </div>
        </div>
      )}

      {/* 回收站弹窗 */}
      {binOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={() => { setBinOpen(false); setPendingHardDeleteId(null) }}>
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[80vh] overflow-y-auto p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-[17px] font-semibold">回收站</h2>
                <p className="text-[12px] text-neutral-400 mt-0.5">删除的隐患在此保留，可恢复；彻底删除后不可找回</p>
              </div>
              <button onClick={() => { setBinOpen(false); setPendingHardDeleteId(null) }} className="p-1.5 text-neutral-400 hover:text-neutral-700 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {binLoading ? (
              <p className="text-[13px] text-neutral-400 py-8 text-center">加载中…</p>
            ) : binItems.length === 0 ? (
              <p className="text-[13px] text-neutral-400 py-8 text-center">回收站是空的</p>
            ) : (
              <ul className="divide-y divide-neutral-100">
                {binItems.map((i) => (
                  <li key={i.id} className="py-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="text-[14px] font-medium leading-snug">{i.title}</div>
                      <div className="text-[12px] text-neutral-400 flex gap-3 flex-wrap">
                        <span>删除于 {fmtDateTime(i.deletedAt!)}</span>
                        {tagName(i.categoryId) && <span>类型 · {tagName(i.categoryId)}</span>}
                        <span>{RISK_LABEL[i.riskLevel]}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleRestore(i.id)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-[#007AFF]/10 text-[#007AFF] text-[12px] font-medium hover:bg-[#007AFF]/18 transition-colors"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        恢复
                      </button>
                      <button
                        onClick={() => confirmHardDelete(i)}
                        className={
                          pendingHardDeleteId === i.id
                            ? 'px-3 py-1.5 rounded-full bg-[#FF3B30] text-white text-[12px] font-medium'
                            : 'px-3 py-1.5 rounded-full text-[#FF3B30] text-[12px] hover:bg-[#FF3B30]/8 transition-colors'
                        }
                      >
                        {pendingHardDeleteId === i.id ? '确认彻底删除' : '彻底删除'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* 大图查看 */}
      {lightbox && lightboxIssue && (lightboxIssue.photos?.length ?? 0) > 0 && (
        <div className="fixed inset-0 z-50 bg-black/85 flex flex-col items-center justify-center p-4" onClick={() => { setLightbox(null); setPendingPhotoDelete(null) }}>
          <div className="relative max-w-3xl w-full flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
            <img
              src={lightboxIssue.photos[lightbox.index]}
              alt=""
              className="max-h-[76vh] max-w-full rounded-xl object-contain"
            />
            {lightboxIssue.photos.length > 1 && (
              <>
                <button
                  onClick={() => setLightbox({ issueId: lightbox.issueId, index: (lightbox.index - 1 + lightboxIssue.photos.length) % lightboxIssue.photos.length })}
                  className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <button
                  onClick={() => setLightbox({ issueId: lightbox.issueId, index: (lightbox.index + 1) % lightboxIssue.photos.length })}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </>
            )}
          </div>
          <div className="mt-3 flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
            <span className="text-white/70 text-[12px]">{lightbox.index + 1} / {lightboxIssue.photos.length}</span>
            <button
              onClick={() => confirmRemovePhoto(lightboxIssue, lightboxIssue.photos[lightbox.index])}
              className={
                pendingPhotoDelete === lightboxIssue.photos[lightbox.index]
                  ? 'px-3 py-1.5 rounded-full bg-[#FF3B30] text-white text-[12px] font-medium'
                  : 'px-3 py-1.5 rounded-full bg-white/12 text-white/85 text-[12px] hover:bg-white/20 flex items-center gap-1.5'
              }
            >
              {pendingPhotoDelete === lightboxIssue.photos[lightbox.index] ? '确认删除' : <><Trash2 className="w-3.5 h-3.5" />删除这张照片</>}
            </button>
            <button
              onClick={() => { setLightbox(null); setPendingPhotoDelete(null) }}
              className="px-3 py-1.5 rounded-full bg-white/12 text-white/85 text-[12px] hover:bg-white/20 flex items-center gap-1.5"
            >
              <X className="w-3.5 h-3.5" />关闭
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
