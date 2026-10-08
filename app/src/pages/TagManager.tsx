import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useStore } from '@/lib/store'
import type { TagGroup } from '@/types'

const GROUP_META: Array<{ key: TagGroup; label: string; hint: string }> = [
  { key: 'category', label: '隐患类型', hint: '电气、消防、机械…统计按此维度出分布图' },
  { key: 'location', label: '区域', hint: '车间 / 产线 / 工位，用于区域热力分析' },
  { key: 'custom', label: '自定义标签', hint: '自由维度，如"重复发生""外包作业"' },
]

const PALETTE = ['#007AFF', '#FF9500', '#FF3B30', '#AF52DE', '#34C759', '#5856D6', '#5AC8FA', '#FFCC00']

export default function TagManager() {
  const { tags, addTag, removeTag } = useStore()
  const [names, setNames] = useState<Record<TagGroup, string>>({ category: '', location: '', custom: '' })
  const [dupHint, setDupHint] = useState<Record<TagGroup, string>>({ category: '', location: '', custom: '' })

  const submit = (group: TagGroup) => {
    const name = names[group].trim()
    if (!name) return
    if (tags.some((t) => t.group === group && t.name === name)) {
      setDupHint({ ...dupHint, [group]: `「${name}」已存在` })
      return
    }
    setDupHint({ ...dupHint, [group]: '' })
    addTag({ name, group, color: PALETTE[Math.floor(Math.random() * PALETTE.length)] })
    setNames({ ...names, [group]: '' })
  }

  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">标签管理</h1>
        <p className="text-sm text-neutral-500 mt-1">按维度组维护标签体系，内置标签不可删除</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {GROUP_META.map(({ key, label, hint }) => (
          <section key={key} className="bg-white rounded-2xl p-5 shadow-sm space-y-3">
            <div>
              <h2 className="text-[15px] font-semibold">{label}</h2>
              <p className="text-[12px] text-neutral-400 mt-0.5">{hint}</p>
            </div>
            <div className="flex flex-wrap gap-2 min-h-8">
              {tags.filter((t) => t.group === key).map((t) => (
                <span
                  key={t.id}
                  className="group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[13px]"
                  style={{ backgroundColor: `${t.color}1F`, color: t.color }}
                >
                  {t.name}
                  {!t.builtin && (
                    <button onClick={() => removeTag(t.id)} className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-1.5 rounded-lg bg-neutral-100/80 text-[13px] outline-none focus:ring-2 ring-[#007AFF]/30"
                placeholder={`新增${label}`}
                value={names[key]}
                onChange={(e) => {
                  setNames({ ...names, [key]: e.target.value })
                  if (dupHint[key]) setDupHint({ ...dupHint, [key]: '' })
                }}
                onKeyDown={(e) => e.key === 'Enter' && submit(key)}
              />
              <button
                onClick={() => submit(key)}
                className="p-1.5 rounded-lg bg-[#007AFF] text-white hover:bg-[#0066D6] transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
            {dupHint[key] && <p className="text-[12px] text-[#D70015] px-1">{dupHint[key]}</p>}
          </section>
        ))}
      </div>
    </div>
  )
}
