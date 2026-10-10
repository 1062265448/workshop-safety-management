import { useMemo, useState } from 'react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useStore } from '@/lib/store'
import { fmtDate } from '@/lib/format'
import { RISK_COLOR, RISK_LABEL } from '@/components/badges'
import PageHelpLink from '@/components/PageHelpLink'
import type { RiskLevel } from '@/types'

type Period = 'week' | 'month' | 'quarter'
const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30, quarter: 90 }
const PERIOD_LABEL: Record<Period, string> = { week: '近 7 天', month: '近 30 天', quarter: '近 90 天' }

export default function Statistics() {
  const { issues: allIssues, tags } = useStore()
  const [period, setPeriod] = useState<Period>('month')
  /** 统计范围：成品车间（闭环管理）/ 其他车间（厂督察重点参考）/ 全部 */
  const [scope, setScope] = useState<'' | 'managed' | 'reference'>('managed')

  const data = useMemo(() => {
    // 统计范围：默认仅成品车间（managed）；可选其他车间参考件，用于观察厂督察检查重点
    const issues = allIssues.filter((i) => !scope || i.scope === scope)
    const days = PERIOD_DAYS[period]
    const since = Date.now() - days * 86_400_000
    const inPeriod = issues.filter((i) => new Date(i.foundAt).getTime() >= since)

    // 新增趋势（按天）
    const trend = Array.from({ length: days }, (_, idx) => {
      const d = new Date(since + (idx + 1) * 86_400_000)
      const key = fmtDate(d.toISOString())
      return {
        date: `${d.getMonth() + 1}/${d.getDate()}`,
        新增: inPeriod.filter((i) => fmtDate(i.foundAt) === key).length,
        闭环: issues.filter((i) => i.closedAt && fmtDate(i.closedAt) === key).length,
      }
    })

    // 类型分布
    const byCategory = tags
      .filter((t) => t.group === 'category')
      .map((t) => ({ name: t.name, value: inPeriod.filter((i) => i.categoryId === t.id).length, color: t.color }))
      .filter((x) => x.value > 0)

    // 区域分布（按数量降序，便于一眼看出厂督察检查重点）
    const byLocation = tags
      .filter((t) => t.group === 'location')
      .map((t) => ({ name: t.name, 数量: inPeriod.filter((i) => i.locationId === t.id).length }))
      .filter((x) => x.数量 > 0)
      .sort((a, b) => b.数量 - a.数量)

    // 风险等级
    const byRisk = (['general', 'major', 'critical'] as RiskLevel[]).map((r) => ({
      name: RISK_LABEL[r], value: inPeriod.filter((i) => i.riskLevel === r).length,
    }))

    // 闭环率：期内闭环 / 期内到期应整改（参考件无整改期限，闭环率无意义，显示 —）
    const due = issues.filter((i) => i.deadline && new Date(i.deadline).getTime() >= since)
    const closedInPeriod = issues.filter((i) => i.closedAt && new Date(i.closedAt).getTime() >= since)
    const closeRate = scope === 'reference' ? null : (due.length ? Math.round((due.filter((i) => i.status === 'closed').length / due.length) * 100) : 100)

    return { trend, byCategory, byLocation, byRisk, total: inPeriod.length, closed: closedInPeriod.length, closeRate }
  }, [allIssues, tags, period, scope])

  const card = 'bg-white rounded-2xl p-5 shadow-sm'

  return (
    <div className="max-w-5xl space-y-6">
      <header className="space-y-3">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-semibold">周期统计</h1>
            <p className="text-sm text-neutral-500 mt-1">
              新增 {data.total} 条 · 闭环 {data.closed} 条{data.closeRate !== null && ` · 按期闭环率 ${data.closeRate}%`} · <PageHelpLink />
            </p>
          </div>
          <div className="flex gap-1 bg-neutral-200/60 p-1 rounded-xl">
            {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3.5 py-1.5 rounded-lg text-[13px] transition-colors ${period === p ? 'bg-white shadow-sm font-medium' : 'text-neutral-500'}`}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
        {/* 统计范围：其他车间参考件的趋势即厂督察近期检查重点 */}
        <div className="flex gap-1 bg-neutral-200/60 p-1 rounded-xl w-fit">
          {([['managed', '成品车间'], ['reference', '其他车间'], ['', '全部']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setScope(key)}
              className={`px-4 py-1.5 rounded-lg text-[13px] transition-colors ${scope === key ? 'bg-white shadow-sm font-medium' : 'text-neutral-500'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {/* 新增趋势 */}
      <section className={card}>
        <h2 className="text-[15px] font-semibold mb-4">新增与闭环趋势</h2>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data.trend}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#999' }} tickLine={false} axisLine={false} interval={Math.floor(data.trend.length / 8)} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#999' }} tickLine={false} axisLine={false} width={28} />
            <Tooltip />
            <Area type="monotone" dataKey="新增" stroke="#FF9500" fill="#FF9500" fillOpacity={0.12} strokeWidth={2} />
            <Area type="monotone" dataKey="闭环" stroke="#34C759" fill="#34C759" fillOpacity={0.12} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 类型分布：标签直接标在扇形旁，一眼看清占比 */}
        <section className={card}>
          <h2 className="text-[15px] font-semibold mb-2">类型分布</h2>
          {data.byCategory.length === 0 ? (
            <p className="text-[13px] text-neutral-400 py-8 text-center">期内暂无数据</p>
          ) : (
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie
                  data={data.byCategory} dataKey="value" nameKey="name"
                  innerRadius={40} outerRadius={62} paddingAngle={3}
                  label={({ name, value }) => `${name} ${value}`}
                  labelLine={{ stroke: '#d2d2d7' }}
                  fontSize={11}
                >
                  {data.byCategory.map((c) => <Cell key={c.name} fill={c.color} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          )}
        </section>

        {/* 区域分布 */}
        <section className={card}>
          <h2 className="text-[15px] font-semibold mb-2">区域分布</h2>
          {data.byLocation.length === 0 ? (
            <p className="text-[13px] text-neutral-400 py-8 text-center">期内暂无数据</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(200, data.byLocation.length * 30)}>
              <BarChart data={data.byLocation} layout="vertical" margin={{ left: 8 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" interval={0} tick={{ fontSize: 12, fill: '#666' }} tickLine={false} axisLine={false} width={84} />
                <Tooltip />
                <Bar dataKey="数量" fill="#007AFF" radius={[0, 6, 6, 0]} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </section>

        {/* 风险等级 */}
        <section className={card}>
          <h2 className="text-[15px] font-semibold mb-3">风险等级构成</h2>
          <ul className="space-y-2.5">
            {data.byRisk.map((r, idx) => {
              const total = Math.max(1, data.total)
              const key = (['general', 'major', 'critical'] as RiskLevel[])[idx]
              return (
                <li key={r.name}>
                  <div className="flex justify-between text-[13px] mb-1">
                    <span className="text-neutral-600">{r.name}隐患</span>
                    <span className="tabular-nums text-neutral-400">{r.value}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-neutral-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${RISK_COLOR[key].split(' ')[0].replace('/12', '')}`}
                      style={{ width: `${(r.value / total) * 100}%`, backgroundColor: ['#34C759', '#FF9500', '#FF3B30'][idx] }}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      </div>
    </div>
  )
}
