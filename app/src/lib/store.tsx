import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { InspectionPlan, IssueAnnotation, Reminder, SafetyIssue, Tag } from '@/types'

// ─────────────────────────────────────────────────────────────
// API 存储层：所有数据走 NestJS 后端（PostgreSQL）
// 通过 Vite 代理访问 /api → http://localhost:3100/api
// ─────────────────────────────────────────────────────────────

interface State {
  issues: SafetyIssue[]
  tags: Tag[]
  plans: InspectionPlan[]
  reminders: Reminder[]
  annotations: IssueAnnotation[]
  loading: boolean
  /** 后端不可达时给出提示 */
  offline: boolean
}

interface Store extends State {
  addIssue: (issue: Omit<SafetyIssue, 'id' | 'createdAt' | 'updatedAt'>) => void
  addIssues: (issues: Array<Omit<SafetyIssue, 'id' | 'createdAt' | 'updatedAt'>>) => void
  updateIssue: (id: string, patch: Partial<SafetyIssue>) => void
  /** 记录一次防复发复查（成品车间隐患要求至少 recheckRequired 次）；failed=true 表示复查不合格（复发顺延：要求次数 +1） */
  recheckIssue: (id: string, failed?: boolean) => void
  /** 整改闭环阶段推进：完成当前阶段（制度沉淀阶段可带制度要点与知识库条目 id） */
  advanceStage: (id: string, body?: { note?: string; linkedKnowledgeDocId?: string }) => void
  removeIssue: (id: string) => void
  /** 回收站：拉取已删除列表 */
  fetchBin: () => Promise<SafetyIssue[]>
  /** 回收站：恢复 */
  restoreIssue: (id: string) => void
  /** 回收站：彻底删除（不可恢复） */
  hardDeleteIssue: (id: string) => void
  addTag: (tag: Omit<Tag, 'id' | 'builtin'>) => void
  /** 幂等建档：存在返回已有标签，不存在则创建（导入自动建档用） */
  ensureTag: (name: string, group: Tag['group']) => Promise<Tag | undefined>
  updateTag: (id: string, patch: Partial<Tag>) => void
  removeTag: (id: string) => void
  addPlan: (plan: Omit<InspectionPlan, 'id' | 'createdAt'>) => void
  updatePlan: (id: string, patch: Partial<InspectionPlan>) => void
  removePlan: (id: string) => void
  /** 执行闭环：记台账、推进下一周期、清理提醒 */
  completePlan: (id: string, body: { executor?: string; note?: string; issueIds?: string[] }) => void
  markReminderRead: (id: string) => void
  refreshReminders: () => void
  /** 关联法规依据（返回带最新关联的隐患并局部更新） */
  linkRegulation: (issueId: string, regulationId: string) => void
  /** 取消法规依据关联 */
  unlinkRegulation: (issueId: string, regulationId: string) => void
  /** 保存参考件标注（upsert，一隐患一条） */
  saveAnnotation: (issueId: string, body: { relevance: string; similarity: string; caution: string; tagId?: string | null }) => void
  /** 清除参考件标注 */
  removeAnnotation: (issueId: string) => void
}

const StoreContext = createContext<Store | null>(null)

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('wsms-token')
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  if (res.status === 401) {
    // 登录失效：清 token 并回到登录页
    localStorage.removeItem('wsms-token')
    window.location.reload()
    throw new Error('登录已过期')
  }
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

/** 上传前压缩：最长边压到 1600px、JPEG 0.8（300KB 以下不压；解码失败退回原文件） */
async function compressPhoto(file: File): Promise<File> {
  if (file.size <= 300 * 1024) return file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff' // PNG 透明底垫白，转 JPEG 不发黑
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' })
  } catch {
    return file
  }
}

/** 单块上传（≤3 张），失败抛错由调用方处理 */
async function uploadChunk(files: File[]): Promise<string[]> {
  const token = localStorage.getItem('wsms-token')
  const fd = new FormData()
  for (const f of files) fd.append('files', await compressPhoto(f))
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  })
  if (!res.ok) throw new Error(`照片上传失败 → ${res.status}`)
  const data = (await res.json()) as { paths: string[] }
  return data.paths
}

/** 上传隐患照片，返回可持久化的路径列表（/uploads/xxx）
 *  公网隧道（cloudflared）对大体积单请求容易 502，故每请求最多 3 张、失败自动重试一次；
 *  重试成功时前一次可能残留孤儿文件（无数据库引用，无害，定期清 uploads 即可） */
export async function uploadPhotos(files: File[]): Promise<string[]> {
  if (!files.length) return []
  const paths: string[] = []
  for (let i = 0; i < files.length; i += 3) {
    const chunk = files.slice(i, i + 3)
    try {
      paths.push(...(await uploadChunk(chunk)))
    } catch {
      paths.push(...(await uploadChunk(chunk))) // 失败重试一次，仍失败则异常向上抛
    }
  }
  return paths
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ issues: [], tags: [], plans: [], reminders: [], annotations: [], loading: true, offline: false })

  const reload = useCallback(async () => {
    try {
      const [issues, tags, plans, reminders, annotations] = await Promise.all([
        api<SafetyIssue[]>('/issues'),
        api<Tag[]>('/tags'),
        api<InspectionPlan[]>('/plans'),
        api<Reminder[]>('/reminders'),
        api<IssueAnnotation[]>('/annotations'),
      ])
      setState({ issues, tags, plans, reminders, annotations, loading: false, offline: false })
    } catch {
      setState((p) => ({ ...p, loading: false, offline: true }))
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  /** 调后端 → 成功后局部更新状态，避免整表重拉 */
  const store = useMemo<Store>(() => {
    const run = (fn: () => Promise<void>) => {
      fn().catch((e) => {
        console.error('[store]', e)
        // 操作失败不能静默：置离线标记让顶部提示条出现，并尝试重连刷新
        setState((p) => ({ ...p, offline: true }))
        reload().catch(() => undefined)
      })
    }
    return {
      ...state,
      addIssue: (issue) =>
        run(async () => {
          const created = await api<SafetyIssue>('/issues', { method: 'POST', body: JSON.stringify(issue) })
          setState((p) => ({ ...p, issues: [created, ...p.issues] }))
        }),
      addIssues: (issues) =>
        run(async () => {
          const created = await api<SafetyIssue[]>('/issues/batch', { method: 'POST', body: JSON.stringify({ items: issues }) })
          setState((p) => ({ ...p, issues: [...created, ...p.issues] }))
        }),
      updateIssue: (id, patch) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
          setState((p) => ({ ...p, issues: p.issues.map((i) => (i.id === id ? updated : i)) }))
        }),
      recheckIssue: (id, failed) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${id}/recheck`, { method: 'POST', body: JSON.stringify({ failed: failed === true }) })
          setState((p) => ({
            ...p,
            issues: p.issues.map((i) => (i.id === id ? updated : i)),
            // 后端已清掉该隐患的复查提醒，本地同步移除
            reminders: p.reminders.filter((r) => !(r.type === 'recheck' && r.refId.startsWith(`${id}#`))),
          }))
        }),
      advanceStage: (id, body) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${id}/stage/next`, { method: 'POST', body: JSON.stringify(body ?? {}) })
          setState((p) => ({ ...p, issues: p.issues.map((i) => (i.id === id ? updated : i)) }))
        }),
      removeIssue: (id) =>
        run(async () => {
          // 软删除：进回收站，标注保留可恢复
          await api(`/issues/${id}`, { method: 'DELETE' })
          setState((p) => ({
            ...p,
            issues: p.issues.filter((i) => i.id !== id),
          }))
        }),
      /** 回收站列表（已软删除的隐患） */
      fetchBin: () => api<SafetyIssue[]>('/issues?bin=1'),
      restoreIssue: (id) =>
        run(async () => {
          const restored = await api<SafetyIssue>(`/issues/${id}/restore`, { method: 'POST' })
          setState((p) => ({ ...p, issues: [restored, ...p.issues] }))
        }),
      hardDeleteIssue: (id) =>
        run(async () => {
          await api(`/issues/${id}/hard`, { method: 'DELETE' })
          setState((p) => ({
            ...p,
            annotations: p.annotations.filter((a) => a.issueId !== id),
          }))
        }),
      addTag: (tag) =>
        run(async () => {
          const created = await api<Tag>('/tags', { method: 'POST', body: JSON.stringify(tag) })
          setState((p) => ({ ...p, tags: [...p.tags, created] }))
        }),
      ensureTag: async (name, group) => {
        try {
          const tag = await api<Tag>('/tags/ensure', { method: 'POST', body: JSON.stringify({ name, group }) })
          setState((p) => (p.tags.some((t) => t.id === tag.id) ? p : { ...p, tags: [...p.tags, tag] }))
          return tag
        } catch (e) {
          console.error('[store] ensureTag', e)
          return undefined
        }
      },
      updateTag: (id, patch) =>
        run(async () => {
          const updated = await api<Tag>(`/tags/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
          setState((p) => ({ ...p, tags: p.tags.map((t) => (t.id === id ? updated : t)) }))
        }),
      removeTag: (id) =>
        run(async () => {
          await api(`/tags/${id}`, { method: 'DELETE' })
          setState((p) => ({
            ...p,
            tags: p.tags.filter((t) => t.id !== id),
            issues: p.issues.map((i) => ({
              ...i,
              tagIds: i.tagIds.filter((t) => t !== id),
              categoryId: i.categoryId === id ? undefined : i.categoryId,
              locationId: i.locationId === id ? undefined : i.locationId,
            })),
          }))
        }),
      addPlan: (plan) =>
        run(async () => {
          const created = await api<InspectionPlan>('/plans', { method: 'POST', body: JSON.stringify(plan) })
          setState((p) => ({ ...p, plans: [...p.plans, created] }))
        }),
      updatePlan: (id, patch) =>
        run(async () => {
          const updated = await api<InspectionPlan>(`/plans/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
          setState((p) => ({ ...p, plans: p.plans.map((pl) => (pl.id === id ? updated : pl)) }))
        }),
      removePlan: (id) =>
        run(async () => {
          await api(`/plans/${id}`, { method: 'DELETE' })
          setState((p) => ({ ...p, plans: p.plans.filter((pl) => pl.id !== id) }))
        }),
      completePlan: (id, body) =>
        run(async () => {
          await api<InspectionPlan>(`/plans/${id}/complete`, { method: 'POST', body: JSON.stringify(body) })
          const [plans, reminders] = await Promise.all([api<InspectionPlan[]>('/plans'), api<Reminder[]>('/reminders')])
          setState((p) => ({ ...p, plans, reminders }))
        }),
      markReminderRead: (id) =>
        run(async () => {
          const updated = await api<Reminder>(`/reminders/${id}/read`, { method: 'PATCH' })
          setState((p) => ({ ...p, reminders: p.reminders.map((r) => (r.id === id ? updated : r)) }))
        }),
      refreshReminders: () =>
        run(async () => {
          await api('/reminders/refresh', { method: 'POST' })
          const reminders = await api<Reminder[]>('/reminders')
          setState((p) => ({ ...p, reminders }))
        }),
      linkRegulation: (issueId, regulationId) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${issueId}/regulations`, { method: 'POST', body: JSON.stringify({ regulationId }) })
          setState((p) => ({ ...p, issues: p.issues.map((i) => (i.id === issueId ? updated : i)) }))
        }),
      unlinkRegulation: (issueId, regulationId) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${issueId}/regulations/${regulationId}`, { method: 'DELETE' })
          setState((p) => ({ ...p, issues: p.issues.map((i) => (i.id === issueId ? updated : i)) }))
        }),
      saveAnnotation: (issueId, body) =>
        run(async () => {
          const saved = await api<IssueAnnotation>(`/annotations/${issueId}`, { method: 'PUT', body: JSON.stringify(body) })
          setState((p) => ({
            ...p,
            annotations: [saved, ...p.annotations.filter((a) => a.issueId !== issueId)],
          }))
        }),
      removeAnnotation: (issueId) =>
        run(async () => {
          await api(`/annotations/${issueId}`, { method: 'DELETE' })
          setState((p) => ({ ...p, annotations: p.annotations.filter((a) => a.issueId !== issueId) }))
        }),
    }
  }, [state])

  // 定时派生提醒（每分钟调后端 refresh；二期可换服务端 cron）
  useEffect(() => {
    if (state.offline) return
    store.refreshReminders()
    const timer = setInterval(() => store.refreshReminders(), 60_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.offline])

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}

/** 工具：判断是否逾期（已闭环 / 正面典型不算逾期） */
export function isOverdue(issue: SafetyIssue): boolean {
  return !issue.isGood && issue.status !== 'closed' && !!issue.deadline && new Date(issue.deadline).getTime() < Date.now()
}
