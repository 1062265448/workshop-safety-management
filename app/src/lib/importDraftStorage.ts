import type { IssueDraft, IssueSource, ReviewDraft } from '@/types'
import type { SkippedPage } from '@/lib/import/parsers'

const DB_NAME = 'wssm-import-drafts'
const DB_VERSION = 1
const STORE_NAME = 'drafts'
const CURRENT_KEY = 'current'

export interface ImportDraftSnapshot {
  drafts: IssueDraft[]
  reviews: ReviewDraft[]
  sourceFiles: Array<{ name: string; source: IssueSource }>
  skipped: Array<SkippedPage & { fileName?: string }>
  idempotencyKey: string | null
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开导入草稿存储'))
    request.onblocked = () => reject(new Error('导入草稿存储被其他页面占用'))
  })
}

export async function loadImportDraft(): Promise<ImportDraftSnapshot | null> {
  const db = await openDatabase()
  try {
    return await new Promise<ImportDraftSnapshot | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).get(CURRENT_KEY)
      request.onsuccess = () => resolve((request.result as ImportDraftSnapshot | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error('无法读取导入草稿'))
      tx.onabort = () => reject(tx.error ?? new Error('读取导入草稿已中止'))
    })
  } finally {
    db.close()
  }
}

export async function saveImportDraft(snapshot: ImportDraftSnapshot): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(snapshot, CURRENT_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('无法保存导入草稿'))
      tx.onabort = () => reject(tx.error ?? new Error('保存导入草稿已中止'))
    })
  } finally {
    db.close()
  }
}

export async function clearImportDraft(): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(CURRENT_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('无法清除导入草稿'))
      tx.onabort = () => reject(tx.error ?? new Error('清除导入草稿已中止'))
    })
  } finally {
    db.close()
  }
}
