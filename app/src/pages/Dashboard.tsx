import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { AlertTriangle, CheckCircle2, Clock3, ListChecks, ArrowRight, RefreshCw, XCircle } from 'lucide-react'
import { api, isOverdue, useStore } from '@/lib/store'
import { getCurrentUser } from '@/lib/auth'
import { fmtDate, fmtDateTime } from '@/lib/format'
import { RiskBadge, StatusBadge } from '@/components/badges'

/** 钉钉通报导入台账记录（与后端 dingtalk_imports 表对应） */
interface ImportRecord {
  messageId: string
  fileName: string
  status: string
  issueCount: number
  dupCount: number
  error: string | null
  createdAt: string
}
interface DingtalkStatus {
  scheduled: string
  group: string
  running: boolean
  lastResult: { at: string; ok: boolean; message: string } | null
  records: ImportRecord[]
}

export default function Dashboard() {
  const { issues: allIssues, plans, reminders } = useStore()
  const isAdmin = getCurrentUser()?.role === 'admin'

  // ── 通报自动导入状态：进首页时拉一次，手动同步后刷新 ──
  const [dtStatus, setDtStatus] = useState<DingtalkStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  useEffect(() => {
    api<DingtalkStatus>('/dingtalk/status').then(setDtStatus).catch(() => undefined)
  }, [])
  const syncNow = async () => {
    if (syncing) return
    setSyncing(true)
    setSyncMsg('')
    try {
      const r = await api<{ message: string }>('/dingtalk/sync-now', { method: 'POST' })
      setSyncMsg(r.message)
      setDtStatus(await api<DingtalkStatus>('/dingtalk/status'))
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : '同步失败')
    } finally {
      setSyncing(false)
    }
  }

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
        <p className="text-sm text-neutral-500 mt-1">下面数字都只算成品车间</p>
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

      {/* 通报自动导入：每天定时从钉钉群拉取厂督察通报入库，这里看执行情况和台账 */}
      <section className="bg-white rounded-2xl p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold">通报自动导入</h2>
            {dtStatus?.lastResult && (
              <span className={`px-2 py-0.5 rounded-md text-[11px] font-medium ${dtStatus.lastResult.ok ? 'bg-[#34C759]/12 text-[#248A3D]' : 'bg-[#FF3B30]/10 text-[#D70015]'}`}>
                {dtStatus.lastResult.ok ? '正常' : '异常'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {dtStatus && (
              <span className="text-[12px] text-neutral-400">
                每天 {dtStatus.scheduled} 从钉钉群「{dtStatus.group}」同步
              </span>
            )}
            {isAdmin && (
              <button
                onClick={syncNow}
                disabled={syncing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#007AFF] text-white text-[12px] font-medium hover:bg-[#0066D6] transition-colors disabled:opacity-40"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? '同步中…' : '立即同步'}
              </button>
            )}
          </div>
        </div>
        {dtStatus?.lastResult ? (
          <p className="text-[13px] text-neutral-600">
            上次执行：{fmtDateTime(dtStatus.lastResult.at)} · {dtStatus.lastResult.message.replace(/^(手动|定时)：/, '')}
          </p>
        ) : (
          <p className="text-[13px] text-neutral-400">还没有执行过同步</p>
        )}
        {syncMsg && <p className="text-[13px] text-[#007AFF] mt-1">{syncMsg}</p>}
        {dtStatus && dtStatus.records.length > 0 && (
          <ul className="divide-y divide-neutral-100 mt-2">
            {dtStatus.records.slice(0, 5).map((r) => {
              const phase = /第(\d+)期/.exec(r.fileName)?.[1]
              return (
                <li key={r.messageId} className="py-2 flex items-center gap-3">
                  {r.status === 'ok' ? (
                    <CheckCircle2 className="w-4 h-4 text-[#34C759] shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-[#FF3B30] shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] truncate">{phase ? `第 ${phase} 期通报` : r.fileName}</div>
                    <div className="text-[12px] text-neutral-400">
                      {r.status === 'ok'
                        ? `入库 ${r.issueCount} 条 · 查重跳过 ${r.dupCount} 条`
                        : `失败：${r.error ?? '未知原因'}`}
                    </div>
                  </div>
                  <span className="text-[12px] text-neutral-400 shrink-0">{fmtDateTime(r.createdAt)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
