import { useState } from 'react'
import { ShieldCheck, Loader2 } from 'lucide-react'

export default function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    if (!username.trim() || !password) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.message ?? '登录失败')
      }
      const { token, user } = await res.json()
      localStorage.setItem('wsms-token', token)
      localStorage.setItem('wsms-user', JSON.stringify(user))
      onLogin(token)
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  const inputCls = 'w-full px-4 py-2.5 rounded-xl bg-neutral-100/80 text-[15px] outline-none focus:ring-2 ring-[#007AFF]/30'

  return (
    <div
      className="min-h-screen bg-[#F5F5F7] flex items-center justify-center p-6"
      style={{ fontFamily: '-apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif' }}
    >
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-[#007AFF] flex items-center justify-center mb-4">
            <ShieldCheck className="w-7 h-7 text-white" strokeWidth={2.2} />
          </div>
          <h1 className="text-xl font-semibold">成品车间安全管理系统</h1>
          <p className="text-[13px] text-neutral-400 mt-1">隐患排查治理闭环 · 请登录</p>
        </div>

        <div className="bg-white rounded-2xl p-6 shadow-sm space-y-3">
          <input className={inputCls} placeholder="用户名" value={username} autoFocus
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} />
          <input className={inputCls} type="password" placeholder="密码" value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} />
          {error && <p className="text-[13px] text-[#D70015] px-1">{error}</p>}
          <button
            onClick={submit}
            disabled={loading || !username.trim() || !password}
            className="w-full py-2.5 rounded-xl bg-[#007AFF] text-white text-[15px] font-medium disabled:opacity-40 hover:bg-[#0066D6] transition-colors flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            登录
          </button>
        </div>
        <p className="text-center text-[12px] text-neutral-400 mt-4">请使用管理员分配的账号登录 · 忘记密码请联系管理员重置</p>
      </div>
    </div>
  )
}
