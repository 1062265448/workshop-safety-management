import { useState } from 'react'
import { Bell, CalendarClock, Plus, Trash2 } from 'lucide-react'
import { useStore } from '@/lib/store'
import PageHelpLink from '@/components/PageHelpLink'
import { fmtDateTime } from '@/lib/format'
import type { PlanFrequency } from '@/types'

const FREQ_LABEL: Record<PlanFrequency, string> = { daily: '每日', weekly: '每周', monthly: '每月', quarterly: '每季度' }

export default function Plans() {
  const { plans, issues, reminders, addPlan, updatePlan, removePlan, completePlan, markReminderRead } = useStore()
  const [form, setForm] = useState({ name: '', scope: '', frequency: 'weekly' as PlanFrequency, nextRunAt: '', remindBeforeMinutes: 60 })
  /** 正在填写执行记录的计划 id */
  const [completingId, setCompletingId] = useState<string | null>(null)
  const [execForm, setExecForm] = useState({ executor: '', note: '', issueIds: [] as string[] })
  /** 待二次确认删除的计划 id（内联确认，不用原生 confirm） */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  const confirmRemovePlan = (id: string) => {
    if (pendingDeleteId === id) {
      removePlan(id)
      setPendingDeleteId(null)
    } else {
      setPendingDeleteId(id)
      setTimeout(() => setPendingDeleteId((cur) => (cur === id ? null : cur)), 3000)
    }
  }

  const openIssues = issues.filter((i) => i.status !== 'closed')

  const submitComplete = (planId: string) => {
    completePlan(planId, {
      executor: execForm.executor.trim(),
      note: execForm.note.trim(),
      issueIds: execForm.issueIds,
    })
    setCompletingId(null)
    setExecForm({ executor: '', note: '', issueIds: [] })
  }

  const submit = () => {
    if (!form.name.trim() || !form.nextRunAt) return
    addPlan({
      name: form.name.trim(),
      scope: form.scope.trim(),
      frequency: form.frequency,
      nextRunAt: new Date(form.nextRunAt).toISOString(),
      checklist: [],
      remindBeforeMinutes: form.remindBeforeMinutes,
      enabled: true,
    })
    setForm({ name: '', scope: '', frequency: 'weekly', nextRunAt: '', remindBeforeMinutes: 60 })
  }

  const inputCls = 'px-3 py-2 rounded-lg bg-neutral-100/80 text-[13px] outline-none focus:ring-2 ring-[#007AFF]/30'

  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">检查计划与提醒</h1>
        <p className="text-sm text-neutral-500 mt-1">周期检查计划到点提醒；整改超期自动生成提醒 · <PageHelpLink /></p>
      </header>

      {/* 新建计划 */}
      <section className="bg-white rounded-2xl p-5 shadow-sm">
        <h2 className="text-[15px] font-semibold mb-3">新建检查计划</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <input className={inputCls} placeholder="计划名称 *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={inputCls} placeholder="检查范围（如：一号车间·消防）" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} />
          <select className={inputCls} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as PlanFrequency })}>
            {(Object.keys(FREQ_LABEL) as PlanFrequency[]).map((f) => <option key={f} value={f}>{FREQ_LABEL[f]}</option>)}
          </select>
          <input type="datetime-local" className={inputCls} value={form.nextRunAt} onChange={(e) => setForm({ ...form, nextRunAt: e.target.value })} />
          <button onClick={submit} className="flex items-center justify-center gap-1.5 rounded-lg bg-[#007AFF] text-white text-[13px] font-medium hover:bg-[#0066D6] transition-colors">
            <Plus className="w-4 h-4" /> 添加
          </button>
        </div>
      </section>

      {/* 计划列表 */}
      <section className="bg-white rounded-2xl shadow-sm divide-y divide-neutral-100">
        {plans.length === 0 && <p className="text-center text-[13px] text-neutral-400 py-8">暂无检查计划</p>}
        {plans.map((p) => {
          const lastExec = p.executions?.[0]
          const completing = completingId === p.id
          return (
            <div key={p.id} className="p-4 space-y-3">
              <div className="flex items-center gap-4">
                <div className="w-9 h-9 rounded-xl bg-[#007AFF]/10 flex items-center justify-center shrink-0">
                  <CalendarClock className="w-4.5 h-4.5 text-[#007AFF]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium">{p.name}</div>
                  <div className="text-[12px] text-neutral-400 mt-0.5">
                    {FREQ_LABEL[p.frequency]} · 下次 {fmtDateTime(p.nextRunAt)} · 提前 {p.remindBeforeMinutes} 分钟提醒{p.scope ? ` · ${p.scope}` : ''}
                  </div>
                  {lastExec && (
                    <div className="text-[12px] text-[#248A3D] mt-0.5">
                      上次执行 {fmtDateTime(lastExec.executedAt)}{lastExec.executor ? ` · ${lastExec.executor}` : ''}{lastExec.issueIds.length ? ` · 关联隐患 ${lastExec.issueIds.length} 条` : ''}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setCompletingId(completing ? null : p.id)}
                  className="px-3.5 py-1.5 rounded-full border border-[#007AFF] text-[#007AFF] text-[12px] font-medium hover:bg-[#007AFF]/5 transition-colors"
                >
                  {completing ? '收起' : '完成本次检查'}
                </button>
                <button
                  onClick={() => updatePlan(p.id, { enabled: !p.enabled })}
                  className={`w-11 h-6.5 rounded-full p-0.5 transition-colors ${p.enabled ? 'bg-[#34C759]' : 'bg-neutral-300'}`}
                >
                  <div className={`w-5.5 h-5.5 rounded-full bg-white shadow transition-transform ${p.enabled ? 'translate-x-[18px]' : ''}`} />
                </button>
                <button
                  onClick={() => confirmRemovePlan(p.id)}
                  className={
                    pendingDeleteId === p.id
                      ? 'px-2.5 py-1 rounded-full bg-[#FF3B30] text-white text-[11px] font-medium'
                      : 'p-1.5 text-neutral-300 hover:text-[#FF3B30] transition-colors'
                  }
                >
                  {pendingDeleteId === p.id ? '确认删除' : <Trash2 className="w-4 h-4" />}
                </button>
              </div>

              {/* 执行闭环表单 */}
              {completing && (
                <div className="ml-13 p-4 rounded-xl bg-neutral-50 border border-neutral-100 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      className={inputCls}
                      placeholder="执行人"
                      value={execForm.executor}
                      onChange={(e) => setExecForm({ ...execForm, executor: e.target.value })}
                    />
                    <input
                      className={inputCls}
                      placeholder="执行情况备注（选填）"
                      value={execForm.note}
                      onChange={(e) => setExecForm({ ...execForm, note: e.target.value })}
                    />
                  </div>
                  {openIssues.length > 0 && (
                    <div>
                      <div className="text-[12px] text-neutral-500 mb-1.5">本次检查发现的隐患（勾选关联，已在库中的）：</div>
                      <div className="flex flex-wrap gap-1.5">
                        {openIssues.map((i) => {
                          const on = execForm.issueIds.includes(i.id)
                          return (
                            <button
                              key={i.id}
                              onClick={() =>
                                setExecForm({
                                  ...execForm,
                                  issueIds: on ? execForm.issueIds.filter((x) => x !== i.id) : [...execForm.issueIds, i.id],
                                })
                              }
                              className={`px-2.5 py-1 rounded-full text-[12px] transition-colors ${on ? 'bg-[#007AFF] text-white' : 'bg-white border border-neutral-200 text-neutral-600'}`}
                            >
                              {i.title.length > 18 ? `${i.title.slice(0, 18)}…` : i.title}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  <div className="flex justify-end">
                    <button
                      onClick={() => submitComplete(p.id)}
                      className="px-4 py-1.5 rounded-full bg-[#34C759] text-white text-[13px] font-medium hover:bg-[#2CB04E] transition-colors"
                    >
                      确认完成并推进下一周期
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </section>

      {/* 提醒中心 */}
      <section className="bg-white rounded-2xl shadow-sm">
        <div className="px-5 pt-4 pb-2 flex items-center gap-2">
          <Bell className="w-4 h-4 text-neutral-400" />
          <h2 className="text-[15px] font-semibold">提醒中心</h2>
        </div>
        <div className="divide-y divide-neutral-100">
          {reminders.length === 0 && <p className="text-center text-[13px] text-neutral-400 py-8">暂无提醒</p>}
          {[...reminders].sort((a, b) => b.triggerAt.localeCompare(a.triggerAt)).map((r) => (
            <div key={r.id} className="px-5 py-3 flex items-center gap-3">
              <span className={`w-2 h-2 rounded-full shrink-0 ${r.read ? 'bg-neutral-200' : 'bg-[#FF3B30]'}`} />
              <div className="flex-1 min-w-0">
                <div className={`text-[14px] ${r.read ? 'text-neutral-400' : ''}`}>{r.title}</div>
                <div className="text-[12px] text-neutral-400">{fmtDateTime(r.triggerAt)}</div>
              </div>
              {!r.read && (
                <button onClick={() => markReminderRead(r.id)} className="text-[12px] text-[#007AFF]">标为已读</button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
