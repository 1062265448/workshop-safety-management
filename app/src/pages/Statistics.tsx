import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Scale, Trash2 } from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { api, useStore } from '@/lib/store'
import { fmtDate } from '@/lib/format'
import { RISK_COLOR, RISK_LABEL } from '@/components/badges'
import type { Assessment, RiskLevel } from '@/types'

type Period = 'week' | 'month' | 'quarter'
const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30, quarter: 90 }
const PERIOD_LABEL: Record<Period, string> = { week: '近 7 天', month: '近 30 天', quarter: '近 90 天' }

/** 考核周期：当月10日 06:00 ~ 次月10日 06:00（日期 >= 10 算本月起，否则上月10日起）；offset 前后翻周期 */
function assessmentMonth(offset = 0): string {
  const now = new Date()
  const base = now.getDate() >= 10 ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const d = new Date(base.getFullYear(), base.getMonth() + offset, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 考核周期起止展示（MM-DD ~ MM-DD） */
function assessmentPeriodLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const end = new Date(y, m, 10)
  return `${m}/10 ~ ${end.getMonth() + 1}/10`
}

export default function Statistics() {
  const { issues: allIssues, tags } = useStore()
  const [period, setPeriod] = useState<Period>('month')
  /** 统计范围：成品车间（闭环管理）/ 其他车间（厂督察重点参考）/ 全部 */
  const [scope, setScope] = useState<'' | 'managed' | 'reference'>('managed')

  // ── 本月考核：周期 = 当月10日 ~ 次月10日，可前后翻周期 ──
  const [asmOffset, setAsmOffset] = useState(0)
  const [asmOpen, setAsmOpen] = useState(false)
  const [assessments, setAssessments] = useState<Assessment[]>([])
  const [pendingAsmDeleteId, setPendingAsmDeleteId] = useState<string | null>(null)
  const asmMonth = assessmentMonth(asmOffset)
  useEffect(() => {
    api<Assessment[]>(`/assessments?month=${asmMonth}`).then(setAssessments).catch(() => setAssessments([]))
  }, [asmMonth])

  const deleteAssessment = (id: string) => {
    if (pendingAsmDeleteId !== id) {
      setPendingAsmDeleteId(id)
      setTimeout(() => setPendingAsmDeleteId((cur) => (cur === id ? null : cur)), 3000)
      return
    }
    api<Assessment>(`/assessments/${id}`, { method: 'DELETE' })
      .then(() => setAssessments((cur) => cur.filter((a) => a.id !== id)))
      .catch(() => {})
    setPendingAsmDeleteId(null)
  }

  // ── 戴明 94/6 根因构成：只统计成品车间已判定根因的隐患 ──
  const causeStats = useMemo(() => {
    const judged = allIssues.filter((i) => i.scope === 'managed' && i.causeType)
    const system = judged.filter((i) => i.causeType === 'system').length
    const individual = judged.filter((i) => i.causeType === 'individual').length
    const total = system + individual
    return { system, individual, total, systemPct: total ? Math.round((system / total) * 100) : 0 }
  }, [allIssues])

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
    const byRisk = (['immediate', 'general', 'critical'] as RiskLevel[]).map((r) => ({
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
              新增 {data.total} 条 · 闭环 {data.closed} 条{data.closeRate !== null && ` · 按期闭环率 ${data.closeRate}%`}
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 根因构成（戴明 94/6）：先问机制，再问人 */}
        <section className={card}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[15px] font-semibold">根因构成</h2>
            <span className="text-[11px] text-neutral-400">成品车间 · 已判定 {causeStats.total} 条</span>
          </div>
          {causeStats.total === 0 ? (
            <p className="text-[13px] text-neutral-400 py-6 text-center">暂无已判定根因的隐患，录入或编辑时选择「根因类别」后计入</p>
          ) : (
            <div className="space-y-3">
              <div className="h-3 rounded-full bg-neutral-100 overflow-hidden flex">
                <div className="h-full bg-[#007AFF]" style={{ width: `${causeStats.systemPct}%` }} />
                <div className="h-full bg-[#FF9500]" style={{ width: `${100 - causeStats.systemPct}%` }} />
              </div>
              <div className="flex justify-between text-[13px]">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#007AFF]" />
                  系统原因 <span className="tabular-nums text-neutral-400">{causeStats.system} 条 · {causeStats.systemPct}%</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#FF9500]" />
                  个人原因 <span className="tabular-nums text-neutral-400">{causeStats.individual} 条 · {100 - causeStats.systemPct}%</span>
                </span>
              </div>
              <p className="text-[12px] text-neutral-400 leading-relaxed">
                戴明 94/6：约 94% 的问题出在系统。先问「什么机制让他容易犯错」，再问「谁错了」。
              </p>
            </div>
          )}
        </section>

        {/* 本月考核：网格责任人重复 2 次提醒 / ≥3 次加倍考核，周期为当月10日 ~ 次月10日 */}
        <section className={card}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[15px] font-semibold flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-[#AF52DE]/12 flex items-center justify-center">
                <Scale className="w-4 h-4 text-[#8944AB]" />
              </span>
              本月考核
            </h2>
            <div className="flex items-center gap-1 text-[12px] text-neutral-400">
              <button onClick={() => setAsmOffset((v) => v - 1)} className="p-1 rounded-md hover:bg-neutral-100 hover:text-neutral-600 transition-colors" title="上一周期">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="tabular-nums">{assessmentPeriodLabel(asmMonth)}</span>
              <button
                onClick={() => setAsmOffset((v) => v + 1)}
                disabled={asmOffset >= 0}
                className="p-1 rounded-md hover:bg-neutral-100 hover:text-neutral-600 transition-colors disabled:opacity-30"
                title="下一周期"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
          <button onClick={() => setAsmOpen((v) => !v)} className="w-full flex items-center justify-between group">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums text-[#8944AB]">{assessments.length}</span>
              <span className="text-[13px] text-neutral-500">条考核记录{assessments.some((a) => a.level === 'double') && `（含加倍考核 ${assessments.filter((a) => a.level === 'double').length} 条）`}</span>
            </div>
            {asmOpen ? <ChevronUp className="w-4 h-4 text-neutral-300 group-hover:text-neutral-500" /> : <ChevronDown className="w-4 h-4 text-neutral-300 group-hover:text-neutral-500" />}
          </button>
          {asmOpen && (
            assessments.length === 0 ? (
              <p className="text-[13px] text-neutral-400 py-4 text-center">本周期暂无考核记录</p>
            ) : (
              <ul className="mt-3 divide-y divide-neutral-100">
                {assessments.map((a) => (
                  <li key={a.id} className="py-2.5 flex items-center gap-3">
                    <span className={`shrink-0 px-2 py-0.5 rounded-md text-[12px] font-medium ${a.level === 'double' ? 'bg-[#AF52DE] text-white' : 'bg-[#AF52DE]/12 text-[#8944AB]'}`}>
                      {a.level === 'double' ? '加倍考核' : '提醒'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] truncate">{a.owner} · {a.issueTitle || '（隐患已删除）'}</div>
                      <div className="text-[12px] text-neutral-400 truncate">{a.note}</div>
                    </div>
                    <button
                      onClick={() => deleteAssessment(a.id)}
                      className={
                        pendingAsmDeleteId === a.id
                          ? 'shrink-0 px-2.5 py-1 rounded-full bg-[#FF3B30] text-white text-[11px] font-medium'
                          : 'shrink-0 p-1.5 text-neutral-300 hover:text-[#FF3B30] transition-colors'
                      }
                      title="删除误记"
                    >
                      {pendingAsmDeleteId === a.id ? '确认删除' : <Trash2 className="w-4 h-4" />}
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}
        </section>
      </div>

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
              const key = (['immediate', 'general', 'critical'] as RiskLevel[])[idx]
              return (
                <li key={r.name}>
                  <div className="flex justify-between text-[13px] mb-1">
                    <span className="text-neutral-600">{r.name}隐患</span>
                    <span className="tabular-nums text-neutral-400">{r.value}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-neutral-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${RISK_COLOR[key].split(' ')[0].replace('/12', '')}`}
                      style={{ width: `${(r.value / total) * 100}%`, backgroundColor: ['#007AFF', '#34C759', '#FF3B30'][idx] }}
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
