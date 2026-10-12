import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { FileUp, Loader2, CheckSquare, Square, ClipboardCheck, ImagePlus, X } from 'lucide-react'
import PageHelpLink from '@/components/PageHelpLink'
import { uploadPhotos, useStore } from '@/lib/store'
import { isManagedWorkshop } from '@/lib/config'
import { detectSource, parseFileOffthread, type SkippedPage } from '@/lib/import/parsers'
import { matchReview } from '@/lib/import/matchReview'
import { RISK_LABEL } from '@/components/badges'
import type { IssueDraft, IssueSource, ReviewDraft, RiskLevel } from '@/types'

export default function IssueEntry() {
  const { tags, issues, addIssue, addIssues, updateIssue, ensureTag } = useStore()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'manual' | 'file'>('manual')

  // ── 手动录入 ──
  const [form, setForm] = useState({
    title: '', description: '', locationId: '', categoryId: '',
    riskLevel: 'general' as RiskLevel, assignee: '', deadline: '',
  })
  /** 待上传的现场照片（本地 File，提交时统一上传） */
  const [photoFiles, setPhotoFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const photoRef = useRef<HTMLInputElement>(null)
  const categories = tags.filter((t) => t.group === 'category')
  const locations = tags.filter((t) => t.group === 'location')

  const submitManual = async () => {
    if (!form.title.trim() || submitting) return
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
        foundAt: new Date().toISOString(),
        deadline: form.deadline ? new Date(form.deadline).toISOString() : undefined,
        photos,
        recheckIntervalDays: 7,
        recheckRequired: 3,
        rechecks: [],
      })
      navigate('/issues')
    } finally {
      setSubmitting(false)
    }
  }

  // ── 文件导入（暂存区模式） ──
  const fileRef = useRef<HTMLInputElement>(null)
  const [parsing, setParsing] = useState(false)
  const [parseStage, setParseStage] = useState('')
  const [importing, setImporting] = useState(false)
  const [sourceFile, setSourceFile] = useState<{ name: string; source: IssueSource } | null>(null)
  const [drafts, setDrafts] = useState<IssueDraft[]>([])
  const [reviews, setReviews] = useState<ReviewDraft[]>([])
  const [skipped, setSkipped] = useState<SkippedPage[]>([])
  const [parseError, setParseError] = useState('')

  /** 按风险等级的默认整改期限（天） */
  const DEADLINE_DAYS: Record<RiskLevel, number> = { critical: 3, major: 7, general: 15 }

  const onPickFile = async (file: File) => {
    const source = detectSource(file.name)
    if (!source) return
    setParsing(true)
    setParseStage('读取文件中…')
    setParseError('')
    setDrafts([])
    setReviews([])
    setSkipped([])
    setSourceFile(null)
    try {
      // 解析在 Web Worker 后台线程执行：大文件解析期间页面不卡死、进度实时可见
      const { drafts: parsed, reviews: parsedReviews, skipped: parsedSkipped } = await parseFileOffthread(
        file,
        (done, total) => setParseStage(`识别页面 ${done}/${total}…`),
      )
      // 自动建档：猜测的车间/类型名与标签库匹配，没有则幂等创建后关联
      const withTags = await Promise.all(
        parsed.map(async (d) => ({
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
      const withMatch = parsedReviews.map((r) => {
        const m = matchReview(r, openIssues, tags)
        return { ...r, matchedIssueId: m?.issueId, matchedIssueTitle: m?.issueTitle }
      })
      setSourceFile({ name: file.name, source })
      setDrafts(withTags)
      setReviews(withMatch)
      setSkipped(parsedSkipped)
    } catch (e) {
      setParseError(e instanceof Error ? e.message : '解析失败')
    } finally {
      setParsing(false)
    }
  }

  const confirmImport = async () => {
    if (!sourceFile || importing) return
    const accepted = drafts.filter((d) => d.accepted)
    const acceptedReviews = reviews.filter((r) => r.accepted && r.matchedIssueId)
    if (!accepted.length && !acceptedReviews.length) return
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
              source: sourceFile.source,
              sourceFile: sourceFile.name,
              reporter: '当前用户',
              foundAt,
              photos,
              recheckIntervalDays: 7,
              recheckRequired: 3,
              rechecks: [],
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
          fixNote: `复查核销：据《${sourceFile.name}》复查页，${r.conclusion}`,
          photos: [...(target?.photos ?? []), ...added].slice(0, 9),
        })
      }
      setDrafts([])
      setReviews([])
      setSkipped([])
      setSourceFile(null)
      navigate('/issues')
    } catch (e) {
      // 照片上传/入库失败要让用户看见原因，不能默默卡死
      setParseError(e instanceof Error ? e.message : '导入失败，请重试')
    } finally {
      setImporting(false)
    }
  }

  const inputCls = 'w-full px-3 py-2 rounded-lg bg-neutral-100/80 text-[14px] outline-none focus:ring-2 ring-[#007AFF]/30'

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">问题录入</h1>
        <p className="text-sm text-neutral-500 mt-1">手动登记隐患，或从 PPT / Word / Excel 批量导入 · <PageHelpLink /></p>
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
        <section className="bg-white rounded-2xl p-6 shadow-sm space-y-4">
          <div>
            <label className="text-[13px] text-neutral-500 block mb-1.5">隐患标题 *</label>
            <input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="例如：配电箱箱门未关闭" />
          </div>
          <div>
            <label className="text-[13px] text-neutral-500 block mb-1.5">问题描述</label>
            <textarea className={`${inputCls} min-h-24`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="位置、现状、风险说明…" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-[13px] text-neutral-500 block mb-1.5">隐患类型</label>
              <select className={inputCls} value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                <option value="">未分类</option>
                {categories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[13px] text-neutral-500 block mb-1.5">所在区域</label>
              <select className={inputCls} value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
                <option value="">未指定</option>
                {locations.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[13px] text-neutral-500 block mb-1.5">风险等级</label>
              <select className={inputCls} value={form.riskLevel} onChange={(e) => setForm({ ...form, riskLevel: e.target.value as RiskLevel })}>
                {(['general', 'major', 'critical'] as const).map((r) => <option key={r} value={r}>{RISK_LABEL[r]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[13px] text-neutral-500 block mb-1.5">整改期限</label>
              <input type="date" className={inputCls} value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className="text-[13px] text-neutral-500 block mb-1.5">整改责任人</label>
              <input className={inputCls} value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} placeholder="选填" />
            </div>
            {/* 现场照片 */}
            <div className="sm:col-span-2">
              <label className="text-[13px] text-neutral-500 block mb-1.5">现场照片</label>
              <div className="flex flex-wrap gap-2">
                {photoFiles.map((f, idx) => (
                  <div key={idx} className="relative w-20 h-20 rounded-xl overflow-hidden bg-neutral-100">
                    <img src={URL.createObjectURL(f)} alt="" className="w-full h-full object-cover" />
                    <button
                      onClick={() => setPhotoFiles(photoFiles.filter((_, i) => i !== idx))}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/55 text-white flex items-center justify-center"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {photoFiles.length < 9 && (
                  <button
                    onClick={() => photoRef.current?.click()}
                    className="w-20 h-20 rounded-xl border-2 border-dashed border-neutral-200 flex flex-col items-center justify-center gap-1 text-neutral-400 hover:border-[#007AFF]/50 hover:text-[#007AFF] transition-colors"
                  >
                    <ImagePlus className="w-5 h-5" />
                    <span className="text-[11px]">添加</span>
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
              <p className="text-[11px] text-neutral-400 mt-1.5">最多 9 张，单张不超过 10MB</p>
            </div>
          </div>
          <div className="pt-2 flex justify-end">
            <button
              onClick={submitManual}
              disabled={!form.title.trim() || submitting}
              className="px-5 py-2 rounded-full bg-[#007AFF] text-white text-[14px] font-medium disabled:opacity-40 hover:bg-[#0066D6] transition-colors flex items-center gap-2"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {submitting ? '上传中…' : '登记入库'}
            </button>
          </div>
        </section>
      ) : (
        <section className="bg-white rounded-2xl p-6 shadow-sm space-y-4">
          {/* 上传区 */}
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full border-2 border-dashed border-neutral-200 rounded-2xl py-10 flex flex-col items-center gap-2 text-neutral-500 hover:border-[#007AFF]/50 hover:text-[#007AFF] transition-colors"
          >
            {parsing ? <Loader2 className="w-6 h-6 animate-spin" /> : <FileUp className="w-6 h-6" />}
            <span className="text-[14px]">{parsing ? `${parseStage || '解析中…'}（后台解析，页面可正常操作）` : '点击选择 PPT / Word / Excel 文件'}</span>
            <span className="text-[12px] text-neutral-400">解析结果进入暂存区，确认后才入库</span>
          </button>
          <input
            ref={fileRef} type="file" className="hidden"
            accept=".ppt,.pptx,.doc,.docx,.xls,.xlsx,.csv"
            onChange={(e) => e.target.files?.[0] && onPickFile(e.target.files[0])}
          />

          {/* 解析失败提示 */}
          {parseError && (
            <div className="px-4 py-2.5 rounded-xl bg-[#FF3B30]/10 text-[#D70015] text-[13px]">{parseError}</div>
          )}

          {/* 暂存区 */}
          {(drafts.length > 0 || reviews.length > 0) && (
            <div className="space-y-3">
              <div className="text-[13px] text-neutral-500">
                来自 <span className="text-neutral-800 font-medium">{sourceFile?.name}</span>，
                识别出 {drafts.length} 条隐患{reviews.length > 0 && `、${reviews.length} 条复查核销`}，勾选确认生效的条目：
              </div>

              {/* 未识别页面：列出页码与内容预览，人工核对是否有漏网隐患 */}
              {skipped.length > 0 && (
                <details className="rounded-xl bg-[#FF9500]/8 border border-[#FF9500]/20 px-4 py-3">
                  <summary className="text-[13px] text-[#B25000] cursor-pointer select-none">
                    {skipped.length} 页未识别（封面、落实类页面属正常跳过），点击展开核对
                  </summary>
                  <ul className="mt-2 space-y-1.5">
                    {skipped.map((s) => (
                      <li key={s.page} className="text-[12px] text-neutral-500 flex gap-2">
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
                          <select
                            className="text-[12px] bg-neutral-100 rounded-md px-2 py-1 outline-none"
                            value={d.categoryId ?? ''}
                            onChange={(e) => patchDraft({ categoryId: e.target.value || undefined })}
                          >
                            <option value="">{d.categoryGuess ? `类型（猜测：${d.categoryGuess}）` : '类型'}</option>
                            {categories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
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
                            {(['general', 'major', 'critical'] as const).map((r) => <option key={r} value={r}>{RISK_LABEL[r]}</option>)}
                          </select>
                        </div>
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
                <span className="text-[12px] text-neutral-400">整改期限按风险等级默认：重大 3 天 / 较大 7 天 / 一般 15 天</span>
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
