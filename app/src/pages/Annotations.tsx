import { useMemo, useState } from 'react'
import { Flag, Loader2, Check } from 'lucide-react'
import { useStore } from '@/lib/store'
import { fmtDate } from '@/lib/format'
import { RISK_LABEL } from '@/components/badges'
import PageHelpLink from '@/components/PageHelpLink'
import type { IssueAnnotation, RelevanceLevel, SafetyIssue } from '@/types'

// ─────────────────────────────────────────────────────────────
// 参考标注：逐条评估其他车间问题对成品车间的参考意义
// 参考意义（高/中/低）+ 成品车间相似点 + 需严格注意事项
// ─────────────────────────────────────────────────────────────

const RELEVANCE_META: Record<RelevanceLevel, { label: string; hint: string; activeCls: string }> = {
  high: { label: '需严格注意', hint: '成品车间有高度相似场景，必须对照排查', activeCls: 'bg-[#FF3B30] text-white' },
  medium: { label: '对照自查', hint: '有参考价值，日常检查中留意', activeCls: 'bg-[#FF9500] text-white' },
  low: { label: '一般了解', hint: '仅作知晓，暂无直接对应场景', activeCls: 'bg-neutral-500 text-white' },
}

export const RELEVANCE_BADGE: Record<RelevanceLevel, { label: string; cls: string }> = {
  high: { label: '需严格注意', cls: 'bg-[#FF3B30]/10 text-[#D70015]' },
  medium: { label: '对照自查', cls: 'bg-[#FF9500]/12 text-[#B25000]' },
  low: { label: '一般了解', cls: 'bg-neutral-500/10 text-neutral-500' },
}

type Filter = 'all' | 'pending' | 'done' | 'high'

export default function Annotations() {
  const { issues, tags, annotations, saveAnnotation, removeAnnotation } = useStore()
  const [filter, setFilter] = useState<Filter>('all')

  const refs = useMemo(
    () => issues.filter((i) => i.scope === 'reference'),
    [issues],
  )
  const byIssueId = useMemo(() => new Map(annotations.map((a) => [a.issueId, a])), [annotations])

  const list = useMemo(() => {
    const sorted = [...refs].sort((a, b) => {
      // 未标注优先，其次高参考意义，其余按发现时间倒序
      const aa = byIssueId.has(a.id) ? 1 : 0
      const bb = byIssueId.has(b.id) ? 1 : 0
      if (aa !== bb) return aa - bb
      return new Date(b.foundAt).getTime() - new Date(a.foundAt).getTime()
    })
    switch (filter) {
      case 'pending': return sorted.filter((i) => !byIssueId.has(i.id))
      case 'done': return sorted.filter((i) => byIssueId.has(i.id))
      case 'high': return sorted.filter((i) => byIssueId.get(i.id)?.relevance === 'high')
      default: return sorted
    }
  }, [refs, byIssueId, filter])

  const doneCount = refs.filter((i) => byIssueId.has(i.id)).length
  const highCount = annotations.filter((a) => a.relevance === 'high' && refs.some((i) => i.id === a.issueId)).length

  return (
    <div className="max-w-3xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">参考标注</h1>
        <p className="text-sm text-neutral-500 mt-1">
          逐条看看其他车间的问题跟咱们像不像、要注意什么 · <PageHelpLink />
        </p>
        <p className="text-[13px] text-neutral-400 mt-1.5">
          已标注 {doneCount} / {refs.length} 条{highCount > 0 && ` · `}
          {highCount > 0 && <span className="text-[#D70015] font-medium">{highCount} 条需严格注意</span>}
        </p>
      </header>

      {/* 筛选 */}
      <div className="flex gap-1 bg-neutral-200/60 p-1 rounded-xl w-fit">
        {([['all', '全部'], ['pending', '未标注'], ['done', '已标注'], ['high', '需严格注意']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-4 py-1.5 rounded-lg text-[14px] transition-colors ${filter === key ? 'bg-white shadow-sm font-medium' : 'text-neutral-500'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {list.length === 0 && (
        <p className="text-[13px] text-neutral-400 py-10 text-center">
          {refs.length === 0 ? '暂无其他车间参考件' : '该筛选下暂无条目'}
        </p>
      )}

      <ul className="space-y-3">
        {list.map((issue) => (
          <AnnotationCard
            key={issue.id}
            issue={issue}
            locationName={tags.find((t) => t.id === issue.locationId)?.name}
            annotation={byIssueId.get(issue.id)}
            onSave={(body) => saveAnnotation(issue.id, body)}
            onClear={() => removeAnnotation(issue.id)}
          />
        ))}
      </ul>
    </div>
  )
}

function AnnotationCard({
  issue, locationName, annotation, onSave, onClear,
}: {
  issue: SafetyIssue
  locationName?: string
  annotation?: IssueAnnotation
  onSave: (body: { relevance: string; similarity: string; caution: string }) => void
  onClear: () => void
}) {
  const [relevance, setRelevance] = useState<RelevanceLevel>(annotation?.relevance ?? 'medium')
  const [similarity, setSimilarity] = useState(annotation?.similarity ?? '')
  const [caution, setCaution] = useState(annotation?.caution ?? '')
  const [saving, setSaving] = useState(false)
  const [savedTick, setSavedTick] = useState(false)

  const dirty =
    relevance !== (annotation?.relevance ?? 'medium') ||
    similarity !== (annotation?.similarity ?? '') ||
    caution !== (annotation?.caution ?? '')

  const save = () => {
    if (saving) return
    setSaving(true)
    onSave({ relevance, similarity, caution })
    // store 失败会置 offline 提示条；本地给一个短暂的"已保存"反馈
    setTimeout(() => { setSaving(false); setSavedTick(true); setTimeout(() => setSavedTick(false), 1600) }, 350)
  }

  const inputCls = 'w-full px-3 py-2 rounded-lg bg-neutral-100/80 text-[13px] outline-none focus:ring-2 ring-[#007AFF]/30'

  return (
    <li className="bg-white rounded-2xl shadow-sm overflow-hidden">
      {/* 问题本体 */}
      <div className="p-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[15px] font-medium leading-snug">{issue.title}</div>
            <div className="text-[12px] text-neutral-400 mt-1">
              {locationName && <span>{locationName} · </span>}
              发现 {fmtDate(issue.foundAt)} · {RISK_LABEL[issue.riskLevel]}
              {issue.sourceFile && <span> · {issue.sourceFile.replace(/\.pptx$/i, '').slice(0, 28)}</span>}
            </div>
          </div>
          {annotation && (
            <span className={`shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium ${RELEVANCE_BADGE[annotation.relevance].cls}`}>
              {RELEVANCE_BADGE[annotation.relevance].label}
            </span>
          )}
        </div>
        {issue.description && (
          <p className="text-[13px] text-neutral-500 mt-2 line-clamp-2">{issue.description}</p>
        )}
      </div>

      {/* 标注区 */}
      <div className="px-4 py-3 bg-[#F5F5F7]/70 border-t border-neutral-100 space-y-2.5">
        <div className="flex items-center gap-1.5 text-[12px] text-neutral-500">
          <Flag className="w-3.5 h-3.5 text-[#FF9500]" />
          问题标注 · 对成品车间的参考意义
        </div>

        {/* 参考意义分级 */}
        <div className="flex gap-1.5">
          {(Object.keys(RELEVANCE_META) as RelevanceLevel[]).map((lv) => (
            <button
              key={lv}
              onClick={() => setRelevance(lv)}
              title={RELEVANCE_META[lv].hint}
              className={`px-3 py-1.5 rounded-lg text-[12px] transition-colors ${
                relevance === lv ? RELEVANCE_META[lv].activeCls : 'bg-white text-neutral-500 border border-neutral-200'
              }`}
            >
              {RELEVANCE_META[lv].label}
            </button>
          ))}
        </div>

        <input
          className={inputCls}
          value={similarity}
          onChange={(e) => setSimilarity(e.target.value)}
          placeholder="成品车间的相似点：哪个区域 / 设备 / 作业与此类似…"
        />
        <textarea
          className={`${inputCls} min-h-14`}
          value={caution}
          onChange={(e) => setCaution(e.target.value)}
          placeholder="需要严格注意：对照排查要点、易忽视环节…"
        />

        <div className="flex items-center justify-end gap-3">
          {annotation && (
            <button onClick={onClear} className="text-[12px] text-neutral-400 hover:text-[#D70015] transition-colors">
              清除标注
            </button>
          )}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="px-4 py-1.5 rounded-full bg-[#007AFF] text-white text-[13px] font-medium disabled:opacity-40 hover:bg-[#0066D6] transition-colors flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : savedTick ? <Check className="w-3.5 h-3.5" /> : null}
            {saving ? '保存中…' : savedTick ? '已保存' : annotation ? '更新标注' : '保存标注'}
          </button>
        </div>
      </div>
    </li>
  )
}
