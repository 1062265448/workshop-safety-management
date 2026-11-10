import { useEffect, useState, type FormEvent } from 'react'
import { Check, CheckCircle2, ChevronDown, CircleAlert, Loader2, Plus, Settings2, Trash2 } from 'lucide-react'
import { api } from '@/lib/store'

interface ModelProfile {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKeySet: boolean
  active: boolean
  lastUsedAt: string
}

interface ModelConfig {
  baseUrl: string
  model: string
  apiKeySet: boolean
  activeProfileId: string
  profiles: ModelProfile[]
}

interface ModelSettingsProps {
  onSaved: () => void
}

export default function ModelSettings({ onSaved }: ModelSettingsProps) {
  const [config, setConfig] = useState<ModelConfig | null>(null)
  const [mode, setMode] = useState<'edit' | 'add'>('edit')
  const [profileName, setProfileName] = useState('')
  const [form, setForm] = useState({ apiKey: '', baseUrl: '', model: '' })
  const [saving, setSaving] = useState(false)
  const [switchingId, setSwitchingId] = useState('')
  const [deletingId, setDeletingId] = useState('')
  const [message, setMessage] = useState('')
  const [loadError, setLoadError] = useState('')
  const busy = saving || !!switchingId || !!deletingId

  const applyConfig = (value: ModelConfig) => {
    setConfig(value)
    setForm({ apiKey: '', baseUrl: value.baseUrl, model: value.model })
    setProfileName('')
    setMode('edit')
  }

  useEffect(() => {
    let active = true
    api<ModelConfig>('/knowledge/config')
      .then((value) => { if (active) applyConfig(value) })
      .catch(() => { if (active) setLoadError('暂时无法读取模型配置，请稍后刷新重试。') })
    return () => { active = false }
  }, [])

  const beginAdd = () => {
    if (!config || busy) return
    setMode('add')
    setMessage('')
    setProfileName('')
    setForm({ apiKey: '', baseUrl: config.baseUrl, model: '' })
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || !form.baseUrl.trim() || !form.model.trim()) return
    setSaving(true)
    setMessage('')
    try {
      const adding = mode === 'add'
      const saved = await api<ModelConfig>(adding ? '/knowledge/config/profiles' : '/knowledge/config', {
        method: adding ? 'POST' : 'PUT',
        body: JSON.stringify({
          name: adding ? profileName.trim() || form.model.trim() : undefined,
          apiKey: form.apiKey || undefined,
          baseUrl: form.baseUrl.trim(),
          model: form.model.trim(),
        }),
      })
      applyConfig(saved)
      setMessage(adding ? '新模型方案已保存并切换，原方案已完整保留。' : '当前方案已保存，相关功能将共同使用新配置。')
      onSaved()
    } catch {
      setMessage(mode === 'add' ? '新增失败，请检查方案信息后重试。' : '保存失败，请检查接口地址和模型名称后重试。')
    } finally {
      setSaving(false)
    }
  }

  const switchProfile = async (profile: ModelProfile) => {
    if (busy || profile.active) return
    setSwitchingId(profile.id)
    setMessage('')
    try {
      const saved = await api<ModelConfig>(`/knowledge/config/profiles/${profile.id}/activate`, { method: 'POST' })
      applyConfig(saved)
      setMessage(`已切换到“${profile.name}”，其他模型方案均已保留。`)
      onSaved()
    } catch {
      setMessage('切换失败，原模型配置未改变，请稍后重试。')
    } finally {
      setSwitchingId('')
    }
  }

  const deleteProfile = async (profile: ModelProfile) => {
    if (busy || profile.active || !window.confirm(`确定删除模型方案“${profile.name}”吗？此操作不会影响当前使用的模型。`)) return
    setDeletingId(profile.id)
    setMessage('')
    try {
      const saved = await api<ModelConfig>(`/knowledge/config/profiles/${profile.id}`, { method: 'DELETE' })
      applyConfig(saved)
      setMessage(`已删除“${profile.name}”，当前模型保持不变。`)
      onSaved()
    } catch {
      setMessage('删除失败，请稍后重试。')
    } finally {
      setDeletingId('')
    }
  }

  const clearKey = async () => {
    if (busy) return
    setSaving(true)
    setMessage('')
    try {
      const saved = await api<ModelConfig>('/knowledge/config', {
        method: 'PUT',
        body: JSON.stringify({ clearApiKey: true }),
      })
      applyConfig(saved)
      setMessage('当前方案的接口密钥已清除，原文检索仍可使用。')
      onSaved()
    } catch {
      setMessage('清除失败，请稍后重试。')
    } finally {
      setSaving(false)
    }
  }

  if (loadError) {
    return (
      <div role="alert" className="flex items-center gap-2 rounded-xl bg-[#FF9500]/10 px-4 py-3 text-[13px] text-[#8A4700]">
        <CircleAlert size={16} /> {loadError}
      </div>
    )
  }

  if (!config) {
    return <div className="flex items-center gap-2 px-1 text-[12px] text-neutral-400"><Loader2 size={14} className="animate-spin" />正在读取模型配置…</div>
  }

  const activeProfile = config.profiles.find((profile) => profile.active)

  return (
    <details className="group rounded-2xl border border-neutral-100 bg-white shadow-sm">
      <summary className="flex min-h-13 cursor-pointer select-none list-none items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-[#007AFF]/30">
        <Settings2 size={16} className="shrink-0 text-neutral-500" />
        <span className="text-[13px] font-medium text-neutral-800">模型配置</span>
        <span className={`h-2 w-2 shrink-0 rounded-full ${config.apiKeySet ? 'bg-[#34C759]' : 'bg-[#FF9500]'}`} />
        <span className="ml-auto hidden max-w-60 truncate text-[12px] text-neutral-500 sm:inline">
          {activeProfile?.name ?? config.model} · {config.profiles.length} 个方案
        </span>
        <ChevronDown size={15} className="shrink-0 text-neutral-400 transition-transform group-open:rotate-180" />
      </summary>

      <div className="space-y-5 border-t border-neutral-100 px-4 pb-5 pt-4 sm:px-5">
        <section aria-labelledby="model-profiles-title">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h3 id="model-profiles-title" className="text-[13px] font-medium text-neutral-800">快速切换模型</h3>
              <p className="mt-1 text-[12px] leading-5 text-neutral-400">每个方案独立保存接口、模型和加密密钥，切换不会覆盖其他方案。</p>
            </div>
            <button
              type="button"
              onClick={mode === 'add' ? () => applyConfig(config) : beginAdd}
              disabled={busy}
              className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-full border border-[#007AFF]/20 px-3 py-1.5 text-[12px] font-medium text-[#007AFF] hover:bg-[#007AFF]/5 disabled:opacity-40"
            >
              <Plus size={14} className={mode === 'add' ? 'rotate-45 transition-transform' : 'transition-transform'} />
              {mode === 'add' ? '取消新增' : '新增模型方案'}
            </button>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {config.profiles.map((profile) => (
              <article key={profile.id} className={`min-w-0 rounded-xl border p-3.5 ${profile.active ? 'border-[#007AFF]/30 bg-[#007AFF]/[0.03]' : 'border-neutral-200 bg-neutral-50/60'}`}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${profile.active ? 'border-[#007AFF] bg-[#007AFF] text-white' : 'border-neutral-300 bg-white'}`}>
                    {profile.active && <Check size={12} strokeWidth={3} />}
                  </span>
                  <h4 className="min-w-0 truncate text-[13px] font-medium text-neutral-900">{profile.name}</h4>
                  {profile.active && <span className="shrink-0 rounded-full bg-[#007AFF]/10 px-2 py-0.5 text-[11px] text-[#007AFF]">使用中</span>}
                </div>
                <p className="mt-2 truncate pl-7 text-[12px] text-neutral-600" title={profile.model}>{profile.model}</p>
                <p className="mt-1 truncate pl-7 text-[11px] text-neutral-400" title={profile.baseUrl}>{profile.baseUrl}</p>
                <div className="mt-3 flex min-h-8 items-center gap-2 pl-7">
                  <span className={`text-[11px] ${profile.apiKeySet ? 'text-[#248A3D]' : 'text-[#8A4700]'}`}>{profile.apiKeySet ? '密钥已保存' : '未保存密钥'}</span>
                  {!profile.active && (
                    <>
                      <button
                        type="button"
                        onClick={() => void switchProfile(profile)}
                        disabled={busy}
                        className="ml-auto inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 text-[12px] font-medium text-neutral-700 hover:border-[#007AFF]/30 hover:text-[#007AFF] disabled:opacity-40"
                      >
                        {switchingId === profile.id && <Loader2 size={12} className="animate-spin" />}
                        {switchingId === profile.id ? '切换中…' : '使用此方案'}
                      </button>
                      <button
                        type="button"
                        aria-label={`删除方案 ${profile.name}`}
                        title="删除此历史方案"
                        onClick={() => void deleteProfile(profile)}
                        disabled={busy}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-[#FF3B30]/5 hover:text-[#D70015] disabled:opacity-40"
                      >
                        {deletingId === profile.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>

        <form onSubmit={save} className={`space-y-4 rounded-xl p-4 ${mode === 'add' ? 'bg-[#007AFF]/[0.04]' : 'border-t border-neutral-100 px-0 pb-0 pt-4'}`}>
          <div>
            <h3 className="text-[13px] font-medium text-neutral-800">{mode === 'add' ? '新增模型方案' : '编辑当前方案'}</h3>
            <p className="mt-1 text-[12px] leading-5 text-neutral-500">
              {mode === 'add' ? '新方案保存后自动切换，当前方案会保留在历史列表中。密钥留空则沿用当前方案。' : '修改仅作用于当前方案。密钥留空表示不更换。'}
            </p>
          </div>
          {mode === 'add' && (
            <div>
              <label htmlFor="profile-display-name" className="mb-1.5 block text-[12px] text-neutral-500">方案名称（可选）</label>
              <input
                id="profile-display-name"
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                placeholder="例如：深度求索日常分析"
                className="min-h-11 w-full rounded-xl bg-white px-3.5 py-2.5 text-[13px] outline-none ring-1 ring-neutral-100 focus:ring-2 focus:ring-[#007AFF]/20"
              />
            </div>
          )}
          <div>
            <label htmlFor="shared-model-key" className="mb-1.5 block text-[12px] text-neutral-500">接口密钥{mode === 'edit' && config.apiKeySet && '（已安全配置）'}</label>
            <input
              id="shared-model-key"
              type="password"
              autoComplete="new-password"
              value={form.apiKey}
              onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
              placeholder={mode === 'add' ? '留空沿用当前方案，或输入新密钥' : config.apiKeySet ? '输入新密钥即可更换' : '请输入接口密钥'}
              className="min-h-11 w-full rounded-xl bg-white px-3.5 py-2.5 text-[13px] outline-none ring-1 ring-neutral-100 focus:ring-2 focus:ring-[#007AFF]/20"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="shared-model-url" className="mb-1.5 block text-[12px] text-neutral-500">接口地址</label>
              <input
                id="shared-model-url"
                value={form.baseUrl}
                onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
                className="min-h-11 w-full rounded-xl bg-white px-3.5 py-2.5 text-[13px] outline-none ring-1 ring-neutral-100 focus:ring-2 focus:ring-[#007AFF]/20"
              />
            </div>
            <div>
              <label htmlFor="shared-model-name" className="mb-1.5 block text-[12px] text-neutral-500">模型名称</label>
              <input
                id="shared-model-name"
                value={form.model}
                onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
                placeholder={mode === 'add' ? '请输入新模型名称' : ''}
                className="min-h-11 w-full rounded-xl bg-white px-3.5 py-2.5 text-[13px] outline-none ring-1 ring-neutral-100 focus:ring-2 focus:ring-[#007AFF]/20"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy || !form.baseUrl.trim() || !form.model.trim()}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#007AFF] px-5 py-2.5 text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {saving ? '正在保存…' : mode === 'add' ? '保存并切换' : '保存当前方案'}
            </button>
            {mode === 'edit' && config.apiKeySet && (
              <button type="button" onClick={clearKey} disabled={busy} className="min-h-11 px-2 text-[12px] text-neutral-400 hover:text-[#D70015] disabled:opacity-40">清除当前方案密钥</button>
            )}
            {message && (
              <p role="status" className={`flex items-start gap-1.5 text-[12px] leading-5 ${message.includes('失败') ? 'text-[#D70015]' : 'text-[#248A3D]'}`}>
                {!message.includes('失败') && <CheckCircle2 size={14} className="mt-0.5 shrink-0" />}{message}
              </p>
            )}
          </div>
        </form>
      </div>
    </details>
  )
}
