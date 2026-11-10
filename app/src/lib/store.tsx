/* eslint-disable react-refresh/only-export-components -- Store Provider 与其数据访问 Hook 共享同一上下文 */
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

type NewIssue = Omit<SafetyIssue, 'id' | 'createdAt' | 'updatedAt'>
type IssuePatch = Omit<Partial<SafetyIssue>, 'scope' | 'status' | 'stage' | 'closedAt' | 'rechecks' | 'reviewed'>

export interface ImportBatchResult {
  batchId: string
  status: 'succeeded'
  items: SafetyIssue[]
  createdCount: number
}

interface Store extends State {
  addIssue: (issue: NewIssue, idempotencyKey: string) => Promise<SafetyIssue>
  addIssues: (issues: NewIssue[], idempotencyKey: string) => Promise<ImportBatchResult>
  updateIssue: (id: string, patch: IssuePatch) => Promise<SafetyIssue>
  transitionIssue: (id: string, status: 'pending' | 'fixing' | 'review') => Promise<SafetyIssue>
  closeIssue: (id: string, body?: { fixNote?: string; photos?: string[]; closedAt?: string }) => Promise<SafetyIssue>
  correctIssueEvidence: (id: string, body: { fixNote?: string; photos?: string[]; reason: string }) => Promise<SafetyIssue>
  reviewIssue: (id: string) => Promise<SafetyIssue>
  /** 记录一次防复发复查；failed=true 时必须由后端校验 note，复发会顺延要求次数。 */
  recheckIssue: (id: string, failed?: boolean, note?: string) => Promise<SafetyIssue>
  /** 整改闭环阶段推进：完成当前阶段（制度沉淀阶段可带制度要点与知识库条目 id） */
  advanceStage: (id: string, body?: { note?: string; linkedKnowledgeDocId?: string }) => Promise<SafetyIssue>
  removeIssue: (id: string) => Promise<void>
  /** 回收站：拉取已删除列表 */
  fetchBin: () => Promise<SafetyIssue[]>
  /** 回收站：恢复 */
  restoreIssue: (id: string) => Promise<SafetyIssue>
  /** 回收站：彻底删除（不可恢复） */
  hardDeleteIssue: (id: string) => Promise<void>
  addTag: (tag: Omit<Tag, 'id' | 'builtin'>) => Promise<Tag>
  /** 幂等建档：存在返回已有标签，不存在则创建（导入自动建档用） */
  ensureTag: (name: string, group: Tag['group']) => Promise<Tag>
  updateTag: (id: string, patch: Partial<Tag>) => Promise<Tag>
  removeTag: (id: string) => Promise<void>
  addPlan: (plan: Omit<InspectionPlan, 'id' | 'createdAt'>) => Promise<InspectionPlan>
  updatePlan: (id: string, patch: Partial<InspectionPlan>) => Promise<InspectionPlan>
  removePlan: (id: string) => Promise<void>
  /** 执行闭环：记台账、推进下一周期、清理提醒 */
  completePlan: (id: string, body: { executor?: string; note?: string; issueIds?: string[] }) => Promise<void>
  markReminderRead: (id: string) => Promise<Reminder>
  refreshReminders: () => Promise<void>
  /** 关联法规依据（返回带最新关联的隐患并局部更新） */
  linkRegulation: (issueId: string, regulationId: string) => Promise<SafetyIssue>
  /** 取消法规依据关联 */
  unlinkRegulation: (issueId: string, regulationId: string) => Promise<SafetyIssue>
  /** 保存参考件标注（upsert，一隐患一条） */
  saveAnnotation: (issueId: string, body: { relevance: string; similarity: string; caution: string; tagId?: string | null }) => Promise<IssueAnnotation>
  /** 清除参考件标注 */
  removeAnnotation: (issueId: string) => Promise<void>
}

const StoreContext = createContext<Store | null>(null)

class ApiError extends Error {
  readonly status?: number
  readonly network: boolean

  constructor(message: string, status?: number, network = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.network = network
  }
}

function isOfflineError(error: unknown): boolean {
  return error instanceof ApiError && (error.network || (error.status ?? 0) >= 500)
}

async function responseError(res: Response, path: string, method: string): Promise<ApiError> {
  let backendMessage = ''
  try {
    const body = (await res.json()) as { message?: string | string[] }
    backendMessage = Array.isArray(body.message) ? body.message.join('；') : body.message ?? ''
  } catch {
    // 非 JSON 错误响应保留状态码即可
  }
  return new ApiError(backendMessage ? `${backendMessage}（HTTP ${res.status}）` : `${method} ${path}（HTTP ${res.status}）`, res.status)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('wsms-token')
  const headers = new Headers(init?.headers)
  if (!(init?.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let res: Response
  try {
    res = await fetch(path, { ...init, headers })
  } catch {
    throw new ApiError('网络连接失败，请检查后端服务是否可用', undefined, true)
  }
  if (res.status === 401) {
    // 登录失效：清 token 并回到登录页
    localStorage.removeItem('wsms-token')
    window.location.reload()
    throw new ApiError('登录已过期（HTTP 401）', 401)
  }
  const method = init?.method ?? 'GET'
  if (!res.ok) throw await responseError(res, path, method)
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export function api<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(`/api${path}`, init)
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
  const fd = new FormData()
  for (const f of files) fd.append('files', await compressPhoto(f))
  const data = await request<{ paths: string[] }>('/api/uploads', { method: 'POST', body: fd })
  return data.paths
}

/** 上传隐患照片，返回可持久化的路径列表（/uploads/xxx）
 *  公网隧道（cloudflared）对大体积单请求容易 502，故每请求最多 3 张、网络错误/5xx 自动重试一次；
 *  重试成功时前一次可能残留孤儿文件（无数据库引用，无害，定期清 uploads 即可） */
export async function uploadPhotos(files: File[]): Promise<string[]> {
  if (!files.length) return []
  const paths: string[] = []
  for (let i = 0; i < files.length; i += 3) {
    const chunk = files.slice(i, i + 3)
    try {
      paths.push(...(await uploadChunk(chunk)))
    } catch (error) {
      if (!isOfflineError(error)) throw error
      paths.push(...(await uploadChunk(chunk))) // 仍失败则异常向上抛
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
    } catch (error) {
      console.error('[store] reload', error)
      setState((p) => ({ ...p, loading: false, offline: isOfflineError(error) }))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /** 调后端 → 成功后局部更新状态；原始 Promise 始终向调用方传递成功或失败 */
  const store = useMemo<Store>(() => {
    const run = <T,>(fn: () => Promise<T>): Promise<T> => {
      const task = fn()
      // 给未 await 的后台/次要操作注册 rejection handler，同时返回原 Promise 供关键操作 await。
      void task.catch((error) => {
        console.error('[store]', error)
        if (isOfflineError(error)) {
          setState((p) => ({ ...p, offline: true }))
          void reload()
        }
      })
      return task
    }
    const updateLocalIssue = (updated: SafetyIssue) => {
      setState((p) => ({ ...p, issues: p.issues.map((i) => (i.id === updated.id ? updated : i)) }))
    }
    return {
      ...state,
      addIssue: (issue, idempotencyKey) =>
        run(async () => {
          const created = await api<SafetyIssue>('/issues', { method: 'POST', body: JSON.stringify({ ...issue, idempotencyKey }) })
          setState((p) => ({ ...p, issues: [created, ...p.issues] }))
          return created
        }),
      addIssues: (issues, idempotencyKey) =>
        run(async () => {
          const result = await api<ImportBatchResult>('/imports/batches', {
            method: 'POST',
            body: JSON.stringify({ items: issues, idempotencyKey, source: 'manual' }),
          })
          setState((p) => {
            // 核销失败后的整批重试会再次返回同一批结果，本地按 id 去重
            const returnedIds = new Set(result.items.map((item) => item.id))
            const existing = p.issues.filter((issue) => !returnedIds.has(issue.id))
            return { ...p, issues: [...result.items, ...existing] }
          })
          return result
        }),
      updateIssue: (id, patch) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
          updateLocalIssue(updated)
          return updated
        }),
      transitionIssue: (id, status) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) })
          updateLocalIssue(updated)
          return updated
        }),
      closeIssue: (id, body) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${id}/close`, { method: 'POST', body: JSON.stringify(body ?? {}) })
          updateLocalIssue(updated)
          return updated
        }),
      correctIssueEvidence: (id, body) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${id}/evidence-corrections`, { method: 'POST', body: JSON.stringify(body) })
          updateLocalIssue(updated)
          return updated
        }),
      reviewIssue: (id) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${id}/reviewed`, { method: 'POST', body: JSON.stringify({}) })
          updateLocalIssue(updated)
          return updated
        }),
      recheckIssue: (id, failed, note) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${id}/recheck`, { method: 'POST', body: JSON.stringify({ failed: failed === true, note }) })
          setState((p) => ({
            ...p,
            issues: p.issues.map((i) => (i.id === id ? updated : i)),
            // 后端已清掉该隐患的复查提醒，本地同步移除
            reminders: p.reminders.filter((r) => !(r.type === 'recheck' && r.refId.startsWith(`${id}#`))),
          }))
          return updated
        }),
      advanceStage: (id, body) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${id}/stage/next`, { method: 'POST', body: JSON.stringify(body ?? {}) })
          updateLocalIssue(updated)
          return updated
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
          return restored
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
          return created
        }),
      ensureTag: (name, group) =>
        run(async () => {
          const tag = await api<Tag>('/tags/ensure', { method: 'POST', body: JSON.stringify({ name, group }) })
          setState((p) => (p.tags.some((t) => t.id === tag.id) ? p : { ...p, tags: [...p.tags, tag] }))
          return tag
        }),
      updateTag: (id, patch) =>
        run(async () => {
          const updated = await api<Tag>(`/tags/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
          setState((p) => ({ ...p, tags: p.tags.map((t) => (t.id === id ? updated : t)) }))
          return updated
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
          return created
        }),
      updatePlan: (id, patch) =>
        run(async () => {
          const updated = await api<InspectionPlan>(`/plans/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
          setState((p) => ({ ...p, plans: p.plans.map((pl) => (pl.id === id ? updated : pl)) }))
          return updated
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
          return updated
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
          updateLocalIssue(updated)
          return updated
        }),
      unlinkRegulation: (issueId, regulationId) =>
        run(async () => {
          const updated = await api<SafetyIssue>(`/issues/${issueId}/regulations/${regulationId}`, { method: 'DELETE' })
          updateLocalIssue(updated)
          return updated
        }),
      saveAnnotation: (issueId, body) =>
        run(async () => {
          const saved = await api<IssueAnnotation>(`/annotations/${issueId}`, { method: 'PUT', body: JSON.stringify(body) })
          setState((p) => ({
            ...p,
            annotations: [saved, ...p.annotations.filter((a) => a.issueId !== issueId)],
          }))
          return saved
        }),
      removeAnnotation: (issueId) =>
        run(async () => {
          await api(`/annotations/${issueId}`, { method: 'DELETE' })
          setState((p) => ({ ...p, annotations: p.annotations.filter((a) => a.issueId !== issueId) }))
        }),
    }
  }, [state, reload])

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
