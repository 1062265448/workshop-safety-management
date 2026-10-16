import { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { useStore } from '@/lib/store'
import type { Tag, TagGroup } from '@/types'

const GROUP_META: Array<{ key: TagGroup; label: string; hint: string }> = [
  { key: 'category', label: '隐患类型', hint: '对应《事故隐患内部分类统计标准明细》20 类，统计按此维度出分布图' },
  { key: 'location', label: '区域', hint: '车间 / 产线 / 工位，用于区域热力分析' },
  { key: 'custom', label: '自定义标签', hint: '自由维度，如"重复发生""外包作业"' },
]

const PALETTE = ['#007AFF', '#FF9500', '#FF3B30', '#AF52DE', '#34C759', '#5856D6', '#5AC8FA', '#FFCC00']

/** 弹窗状态：新增（预选组）或编辑（已有标签） */
type DialogState =
  | { mode: 'add'; group: TagGroup }
  | { mode: 'edit'; tag: Tag }
  | null

export default function TagManager() {
  const { tags, addTag, updateTag, removeTag } = useStore()
  const [dialog, setDialog] = useState<DialogState>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState(PALETTE[0])
  const [error, setError] = useState('')
  /** 子标签管理弹窗：当前查看的父标签 */
  const [subParent, setSubParent] = useState<Tag | null>(null)
  const [subName, setSubName] = useState('')
  const [subError, setSubError] = useState('')

  useEffect(() => {
    if (!dialog) return
    setName(dialog.mode === 'edit' ? dialog.tag.name : '')
    setColor(dialog.mode === 'edit' ? dialog.tag.color : PALETTE[Math.floor(Math.random() * PALETTE.length)])
    setError('')
  }, [dialog])

  useEffect(() => {
    setSubName('')
    setSubError('')
  }, [subParent])

  const dialogGroup: TagGroup | null = dialog ? (dialog.mode === 'add' ? dialog.group : dialog.tag.group) : null

  const submit = () => {
    if (!dialog) return
    const trimmed = name.trim()
    if (!trimmed) return
    if (tags.some((t) => t.group === dialogGroup && t.name === trimmed && (dialog.mode === 'add' || t.id !== dialog.tag.id))) {
      setError(`「${trimmed}」已存在`)
      return
    }
    if (dialog.mode === 'add') addTag({ name: trimmed, group: dialog.group, color })
    else updateTag(dialog.tag.id, { name: trimmed, color })
    setDialog(null)
  }

  /** 新增子标签：维度组与颜色继承父标签 */
  const submitSub = () => {
    if (!subParent) return
    const trimmed = subName.trim()
    if (!trimmed) return
    if (tags.some((t) => t.group === subParent.group && t.name === trimmed)) {
      setSubError(`「${trimmed}」已存在`)
      return
    }
    addTag({ name: trimmed, group: subParent.group, color: subParent.color, parentId: subParent.id })
    setSubName('')
    setSubError('')
  }

  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">标签管理</h1>
        <p className="text-sm text-neutral-500 mt-1">类型、区域、自定义三组标签；内置的删不掉</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {GROUP_META.map(({ key, label, hint }) => (
          <section key={key} className="bg-white rounded-2xl p-5 shadow-sm flex flex-col gap-3">
            <div>
              <h2 className="text-[15px] font-semibold">{label}</h2>
              <p className="text-[12px] text-neutral-400 mt-0.5">{hint}</p>
            </div>
            <div className="flex flex-wrap gap-2 min-h-8 content-start flex-1">
              {tags.filter((t) => t.group === key && !t.parentId).map((t) => {
                const subCount = tags.filter((s) => s.parentId === t.id).length
                return (
                  <span
                    key={t.id}
                    className="group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[13px]"
                    style={{ backgroundColor: `${t.color}1F`, color: t.color }}
                  >
                    {/* 隐患类型标签：点击名字弹窗管理子标签 */}
                    {key === 'category' ? (
                      <button onClick={() => setSubParent(t)} title="查看 / 编辑子标签" className="hover:underline underline-offset-2">
                        {t.name}
                      </button>
                    ) : (
                      t.name
                    )}
                    {subCount > 0 && (
                      <button
                        onClick={() => setSubParent(t)}
                        title="查看子标签"
                        className="px-1 rounded-full text-[10px] font-semibold"
                        style={{ backgroundColor: `${t.color}33` }}
                      >
                        {subCount}
                      </button>
                    )}
                    <button
                      onClick={() => setDialog({ mode: 'edit', tag: t })}
                      title="修改标签"
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    {!t.builtin && (
                      <button
                        onClick={() => removeTag(t.id)}
                        title="删除标签"
                        className="opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                )
              })}
            </div>
            <button
              onClick={() => setDialog({ mode: 'add', group: key })}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-neutral-300 text-[13px] text-neutral-500 hover:border-[#007AFF] hover:text-[#007AFF] hover:bg-[#007AFF]/5 transition-colors"
            >
              <Plus className="w-4 h-4" />
              新增{label}
            </button>
          </section>
        ))}
      </div>

      {dialog && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
          onClick={() => setDialog(null)}
        >
          <div
            className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6 space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[17px] font-semibold">
                {dialog.mode === 'add' ? `新增${GROUP_META.find((g) => g.key === dialog.group)?.label}` : '修改标签'}
              </h3>
              <button onClick={() => setDialog(null)} className="p-1 rounded-full hover:bg-neutral-100 transition-colors">
                <X className="w-4 h-4 text-neutral-500" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="text-[13px] font-medium text-neutral-600">标签名称</label>
              <input
                autoFocus
                className="w-full px-3.5 py-2.5 rounded-xl bg-neutral-100/80 text-[14px] outline-none focus:ring-2 ring-[#007AFF]/30"
                placeholder="输入标签名称"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (error) setError('')
                }}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
              {error && <p className="text-[12px] text-[#D70015]">{error}</p>}
            </div>

            <div className="space-y-1.5">
              <label className="text-[13px] font-medium text-neutral-600">标签颜色</label>
              <div className="flex flex-wrap gap-2">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className="w-8 h-8 rounded-full transition-transform"
                    style={{
                      backgroundColor: c,
                      transform: color === c ? 'scale(1.15)' : undefined,
                      boxShadow: color === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : undefined,
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setDialog(null)}
                className="flex-1 py-2.5 rounded-xl bg-neutral-100 text-[14px] font-medium text-neutral-600 hover:bg-neutral-200 transition-colors"
              >
                取消
              </button>
              <button
                onClick={submit}
                disabled={!name.trim()}
                className="flex-1 py-2.5 rounded-xl bg-[#007AFF] text-[14px] font-medium text-white hover:bg-[#0066D6] disabled:opacity-40 transition-colors"
              >
                {dialog.mode === 'add' ? '新增' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 子标签管理弹窗：查看 / 新增 / 编辑 / 删除某隐患类型下的子标签 */}
      {subParent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
          onClick={() => setSubParent(null)}
        >
          <div
            className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className="px-2.5 py-1 rounded-full text-[13px] font-medium"
                  style={{ backgroundColor: `${subParent.color}1F`, color: subParent.color }}
                >
                  {subParent.name}
                </span>
                <h3 className="text-[15px] font-semibold text-neutral-700">的子标签</h3>
              </div>
              <button onClick={() => setSubParent(null)} className="p-1 rounded-full hover:bg-neutral-100 transition-colors">
                <X className="w-4 h-4 text-neutral-500" />
              </button>
            </div>

            <div className="flex flex-wrap gap-2 min-h-8 content-start">
              {tags.filter((s) => s.parentId === subParent.id).length === 0 && (
                <p className="text-[13px] text-neutral-400 py-2">暂无子标签，在下方添加</p>
              )}
              {tags.filter((s) => s.parentId === subParent.id).map((s) => (
                <span
                  key={s.id}
                  className="group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[13px]"
                  style={{ backgroundColor: `${s.color}1F`, color: s.color }}
                >
                  {s.name}
                  <button
                    onClick={() => setDialog({ mode: 'edit', tag: s })}
                    title="修改子标签"
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => removeTag(s.id)}
                    title="删除子标签"
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>

            <div className="flex gap-2">
              <input
                className="flex-1 px-3.5 py-2.5 rounded-xl bg-neutral-100/80 text-[14px] outline-none focus:ring-2 ring-[#007AFF]/30"
                placeholder={`新增「${subParent.name}」的子标签`}
                value={subName}
                onChange={(e) => {
                  setSubName(e.target.value)
                  if (subError) setSubError('')
                }}
                onKeyDown={(e) => e.key === 'Enter' && submitSub()}
              />
              <button
                onClick={submitSub}
                disabled={!subName.trim()}
                className="px-4 py-2.5 rounded-xl bg-[#007AFF] text-white text-[14px] font-medium hover:bg-[#0066D6] disabled:opacity-40 transition-colors flex items-center gap-1"
              >
                <Plus className="w-4 h-4" />
                添加
              </button>
            </div>
            {subError && <p className="text-[12px] text-[#D70015]">{subError}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
