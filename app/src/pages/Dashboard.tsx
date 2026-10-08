import { Link } from 'react-router'
import { AlertTriangle, CheckCircle2, Clock3, ListChecks, ArrowRight } from 'lucide-react'
import { isOverdue, useStore } from '@/lib/store'
import { fmtDate, fmtDateTime } from '@/lib/format'
import { RiskBadge, StatusBadge } from '@/components/badges'

export default function Dashboard() {
  const { issues: allIssues, plans, reminders } = useStore()

  // 总览只统计成品车间（managed）的隐患，其他车间参考件不参与
  const issues = allIssues.filter((i) => i.scope !== 'reference')
  const open = issues.filter((i) => i.status !== 'closed')
  const overdue = open.filter(isOverdue)
  const closed = issues.filter((i) => i.status === 'closed')
  const closeRate = issues.length ? Math.round((closed.length / issues.length) * 100) : 0
  const unread = reminders.filter((r) => !r.read && !r.done)

  const cards = [
    { label: '待整改隐患', value: open.length, icon: AlertTriangle, color: 'text-[#FF9500]', bg: 'bg-[#FF9500]/10' },
    { label: '已超期', value: overdue.length, icon: Clock3, color: 'text-[#FF3B30]', bg: 'bg-[#FF3B30]/10' },
    { label: '整改闭环率', value: `${closeRate}%`, icon: CheckCircle2, color: 'text-[#34C759]', bg: 'bg-[#34C759]/10' },
    { label: '进行中检查计划', value: plans.filter((p) => p.enabled).length, icon: ListChecks, color: 'text-[#007AFF]', bg: 'bg-[#007AFF]/10' },
  ]

  return (
    <div className="max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">总览</h1>
        <p className="text-sm text-neutral-500 mt-1">隐患排查治理闭环的当前状态</p>
      </header>

      {/* 指标卡 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="bg-white rounded-2xl p-5 shadow-sm">
            <div className={`w-9 h-9 rounded-xl ${bg} flex items-center justify-center mb-3`}>
              <Icon className={`w-4.5 h-4.5 ${color}`} strokeWidth={2} />
            </div>
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
            <div className="text-[13px] text-neutral-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 最近隐患 */}
        <section className="bg-white rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[15px] font-semibold">最新隐患</h2>
            <Link to="/issues" className="text-[13px] text-[#007AFF] flex items-center gap-1">
              全部 <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <ul className="divide-y divide-neutral-100">
            {[...issues].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5).map((i) => (
              <li key={i.id} className="py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] truncate">{i.title}</div>
                  <div className="text-[12px] text-neutral-400">{fmtDate(i.foundAt)}</div>
                </div>
                <RiskBadge level={i.riskLevel} />
                <StatusBadge status={i.status} overdue={isOverdue(i)} />
              </li>
            ))}
          </ul>
        </section>

        {/* 提醒 */}
        <section className="bg-white rounded-2xl p-5 shadow-sm">
          <h2 className="text-[15px] font-semibold mb-3">待处理提醒</h2>
          {unread.length === 0 ? (
            <p className="text-[13px] text-neutral-400 py-6 text-center">暂无提醒</p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {unread.slice(0, 5).map((r) => (
                <li key={r.id} className="py-2.5 flex items-center gap-3">
                  <Clock3 className="w-4 h-4 text-[#FF3B30] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] truncate">{r.title}</div>
                    <div className="text-[12px] text-neutral-400">触发于 {fmtDateTime(r.triggerAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
