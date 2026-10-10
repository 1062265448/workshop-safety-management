import { useState } from 'react'
import { KeyRound, Loader2, X } from 'lucide-react'

/** 修改密码弹窗 */
export default function ChangePassword({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [loading, setLoading] = useState(false)

  const reset = () => {
    setOldPassword('')
    setNewPassword('')
    setConfirm('')
    setMsg(null)
  }

  const submit = async () => {
    if (newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
      return setMsg({ ok: false, text: '新密码至少 8 位，且需同时包含字母和数字' })
    }
    if (newPassword !== confirm) return setMsg({ ok: false, text: '两次输入的新密码不一致' })
    setLoading(true)
    setMsg(null)
    try {
      const token = localStorage.getItem('wsms-token')
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.message ?? '修改失败')
      }
      setMsg({ ok: true, text: '密码已修改，下次登录请使用新密码' })
      setOldPassword('')
      setNewPassword('')
      setConfirm('')
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : '修改失败' })
    } finally {
      setLoading(false)
    }
  }

  const inputCls = 'w-full px-3.5 py-2 rounded-xl bg-neutral-100/80 text-[14px] outline-none focus:ring-2 ring-[#007AFF]/30'

  return (
    <>
      <button
        onClick={() => { reset(); setOpen(true) }}
        className={className ?? 'mx-3 mb-1 flex items-center gap-2.5 px-3 py-2 rounded-lg text-[14px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 transition-colors'}
      >
        <KeyRound className="w-4 h-4" strokeWidth={2} />
        修改密码
      </button>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center p-6" onClick={() => setOpen(false)}>
          <div className="w-full max-w-xs bg-white rounded-2xl p-6 shadow-xl space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">修改密码</h2>
              <button onClick={() => setOpen(false)} className="text-neutral-300 hover:text-neutral-500">
                <X className="w-4.5 h-4.5" />
              </button>
            </div>
            <input className={inputCls} type="password" placeholder="原密码" value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)} autoFocus />
            <input className={inputCls} type="password" placeholder="新密码（≥8 位，含字母和数字）" value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)} />
            <input className={inputCls} type="password" placeholder="确认新密码" value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()} />
            {msg && <p className={`text-[13px] px-1 ${msg.ok ? 'text-[#248A3D]' : 'text-[#D70015]'}`}>{msg.text}</p>}
            <button
              onClick={submit}
              disabled={loading || !oldPassword || !newPassword}
              className="w-full py-2.5 rounded-xl bg-[#007AFF] text-white text-[14px] font-medium disabled:opacity-40 hover:bg-[#0066D6] transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              确认修改
            </button>
          </div>
        </div>
      )}
    </>
  )
}
