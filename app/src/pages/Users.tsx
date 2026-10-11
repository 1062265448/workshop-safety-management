import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Loader2, Pencil, Plus, Trash2, UserRound, X } from 'lucide-react'
import { getCurrentUser, ROLE_LABEL, type CurrentUser } from '@/lib/auth'
import PageHelpLink from '@/components/PageHelpLink'
import { cn } from '@/lib/utils'

// ─────────────────────────────────────────────────────────────
// 用户管理（仅管理员可见入口；后端 admin 角色双重校验）
// ─────────────────────────────────────────────────────────────

const ROLE_COLOR: Record<string, string> = {
  admin: 'bg-[#007AFF]/10 text-[#007AFF]',
  safety_officer: 'bg-[#FF9500]/10 text-[#C93400]',
  viewer: 'bg-neutral-100 text-neutral-500',
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('wsms-token')
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init?.headers },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.message ?? `请求失败 → ${res.status}`)
  return body as T
}

interface UserRow extends CurrentUser { createdAt: string }

export default function Users() {
  const me = getCurrentUser()
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 新建 / 编辑 / 重置密码 弹窗状态
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [resetting, setResetting] = useState<UserRow | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  const [form, setForm] = useState({ username: '', password: '', displayName: '', role: 'safety_officer' as CurrentUser['role'] })
  const [editForm, setEditForm] = useState({ displayName: '', role: 'safety_officer' as CurrentUser['role'] })
  const [newPwd, setNewPwd] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      setUsers(await api<UserRow[]>('/users'))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const run = async (fn: () => Promise<void>) => {
    setSaving(true)
    setMsg(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : '操作失败' })
    } finally {
      setSaving(false)
    }
  }

  const submitCreate = () =>
    run(async () => {
      await api('/users', { method: 'POST', body: JSON.stringify(form) })
      setCreating(false)
      setForm({ username: '', password: '', displayName: '', role: 'safety_officer' })
      setMsg({ ok: true, text: '用户已创建' })
    })

  const submitEdit = () =>
    run(async () => {
      if (!editing) return
      await api(`/users/${editing.id}`, { method: 'PATCH', body: JSON.stringify(editForm) })
      setEditing(null)
      setMsg({ ok: true, text: '已保存' })
    })

  const submitReset = () =>
    run(async () => {
      if (!resetting) return
      await api(`/users/${resetting.id}/reset-password`, { method: 'POST', body: JSON.stringify({ password: newPwd }) })
      setResetting(null)
      setNewPwd('')
      setMsg({ ok: true, text: `已重置「${resetting.username}」的密码` })
    })

  const confirmDelete = (u: UserRow) => {
    if (pendingDeleteId === u.id) {
      void run(async () => {
        await api(`/users/${u.id}`, { method: 'DELETE' })
        setPendingDeleteId(null)
        setMsg({ ok: true, text: `已删除用户「${u.username}」` })
      })
    } else {
      setPendingDeleteId(u.id)
      setTimeout(() => setPendingDeleteId((cur) => (cur === u.id ? null : cur)), 3000)
    }
  }

  const inputCls = 'w-full px-3.5 py-2 rounded-xl bg-neutral-100/80 text-[14px] outline-none focus:ring-2 ring-[#007AFF]/30'
  const selectCls = 'w-full px-3 py-2 rounded-xl bg-neutral-100/80 text-[14px] outline-none focus:ring-2 ring-[#007AFF]/30'

  return (
    <div className="max-w-3xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">用户管理</h1>
        <p className="text-[13px] text-neutral-400 mt-1">
          管理员什么都能干 · 安全员管业务 · 只读账号只能看（改数据会被系统拦下） · <PageHelpLink anchor="roles" />
        </p>
      </header>

      {msg && (
        <p className={cn('px-4 py-2.5 rounded-xl text-[13px]', msg.ok ? 'bg-[#248A3D]/10 text-[#248A3D]' : 'bg-[#FF3B30]/10 text-[#D70015]')}>
          {msg.text}
        </p>
      )}
      {error && <p className="px-4 py-2.5 rounded-xl bg-[#FF3B30]/10 text-[#D70015] text-[13px]">{error}</p>}

      <div className="bg-white rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-medium">共 {users.length} 个账号</span>
          <button
            onClick={() => { setCreating(true); setMsg(null) }}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#007AFF] text-white text-[13px] font-medium hover:bg-[#0066D6] transition-colors"
          >
            <Plus className="w-4 h-4" /> 新建用户
          </button>
        </div>

        {loading ? (
          <div className="py-10 flex justify-center text-neutral-300"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {users.map((u) => (
              <li key={u.id} className="py-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-neutral-100 flex items-center justify-center shrink-0">
                  <UserRound className="w-4.5 h-4.5 text-neutral-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium truncate">{u.displayName || u.username}</span>
                    <span className={cn('px-1.5 py-0.5 rounded-md text-[11px]', ROLE_COLOR[u.role])}>{ROLE_LABEL[u.role]}</span>
                    {u.id === me?.id && <span className="text-[11px] text-neutral-400">当前登录</span>}
                  </div>
                  <div className="text-[12px] text-neutral-400 truncate">@{u.username} · 创建于 {new Date(u.createdAt).toLocaleDateString('zh-CN')}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => { setEditing(u); setEditForm({ displayName: u.displayName, role: u.role }); setMsg(null) }}
                    className="p-2 rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-[#007AFF] transition-colors"
                    title="编辑"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => { setResetting(u); setNewPwd(''); setMsg(null) }}
                    className="p-2 rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-[#FF9500] transition-colors"
                    title="重置密码"
                  >
                    <KeyRound className="w-4 h-4" />
                  </button>
                  {u.id !== me?.id && (
                    <button
                      onClick={() => confirmDelete(u)}
                      className={cn(
                        'p-2 rounded-lg transition-colors',
                        pendingDeleteId === u.id ? 'text-white bg-[#FF3B30]' : 'text-neutral-400 hover:bg-neutral-100 hover:text-[#FF3B30]',
                      )}
                      title={pendingDeleteId === u.id ? '再点一次确认删除' : '删除'}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {pendingDeleteId && <p className="text-[12px] text-[#D70015] px-1">再点一次红色垃圾桶确认删除（3 秒内有效）</p>}

      {/* 新建用户 */}
      {creating && (
        <Dialog title="新建用户" onClose={() => setCreating(false)}>
          <input className={inputCls} placeholder="用户名（2-20 位字母/数字/下划线）" value={form.username} autoFocus
            onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input className={inputCls} type="password" placeholder="初始密码（≥8 位，含字母和数字）" value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <input className={inputCls} placeholder="显示名称（可选）" value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          <select className={selectCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as CurrentUser['role'] })}>
            <option value="safety_officer">安全员（录入与整改闭环）</option>
            <option value="viewer">查看者（仅浏览）</option>
            <option value="admin">管理员</option>
          </select>
          <button onClick={submitCreate} disabled={saving || !form.username || !form.password}
            className="w-full py-2.5 rounded-xl bg-[#007AFF] text-white text-[14px] font-medium disabled:opacity-40 hover:bg-[#0066D6] transition-colors flex items-center justify-center gap-2">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} 创建
          </button>
        </Dialog>
      )}

      {/* 编辑用户 */}
      {editing && (
        <Dialog title={`编辑 @${editing.username}`} onClose={() => setEditing(null)}>
          <input className={inputCls} placeholder="显示名称" value={editForm.displayName} autoFocus
            onChange={(e) => setEditForm({ ...editForm, displayName: e.target.value })} />
          {editing.id === me?.id ? (
            <p className="text-[12px] text-neutral-400 px-1">不能修改自己的角色（当前：{ROLE_LABEL[editing.role]}）</p>
          ) : (
            <select className={selectCls} value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value as CurrentUser['role'] })}>
              <option value="safety_officer">安全员</option>
              <option value="viewer">查看者</option>
              <option value="admin">管理员</option>
            </select>
          )}
          <button onClick={submitEdit} disabled={saving}
            className="w-full py-2.5 rounded-xl bg-[#007AFF] text-white text-[14px] font-medium disabled:opacity-40 hover:bg-[#0066D6] transition-colors flex items-center justify-center gap-2">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} 保存
          </button>
        </Dialog>
      )}

      {/* 重置密码 */}
      {resetting && (
        <Dialog title={`重置「${resetting.username}」的密码`} onClose={() => setResetting(null)}>
          <input className={inputCls} type="password" placeholder="新密码（≥8 位，含字母和数字）" value={newPwd} autoFocus
            onChange={(e) => setNewPwd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitReset()} />
          <button onClick={submitReset} disabled={saving || !newPwd}
            className="w-full py-2.5 rounded-xl bg-[#FF9500] text-white text-[14px] font-medium disabled:opacity-40 hover:bg-[#E08600] transition-colors flex items-center justify-center gap-2">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} 重置密码
          </button>
        </Dialog>
      )}
    </div>
  )
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="w-full max-w-xs bg-white rounded-2xl p-6 shadow-xl space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button onClick={onClose} className="text-neutral-300 hover:text-neutral-500"><X className="w-4.5 h-4.5" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}
