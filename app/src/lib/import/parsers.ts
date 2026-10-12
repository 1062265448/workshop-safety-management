import type { IssueDraft, IssueSource, ReviewDraft } from '@/types'
import { parseDocx } from './parseDocx'
import { parsePptx, type SkippedPage } from './parsePptx'

export type { SkippedPage }
import { parseXlsx } from './parseXlsx'

// ─────────────────────────────────────────────────────────────
// 文档解析调度层
// 职责：PPT / Word / Excel → 暂存区草稿（新隐患 + 复查核销记录），人工确认后生效
// 全部解析在浏览器本地完成，原始文件不出本机
// ─────────────────────────────────────────────────────────────

export interface ParseResult {
  drafts: IssueDraft[]
  reviews: ReviewDraft[]
  /** 未识别出问题的页面（PPT 逐页报告，Word/Excel 恒为空） */
  skipped: SkippedPage[]
}

export function detectSource(fileName: string): IssueSource | null {
  const ext = fileName.toLowerCase().split('.').pop()
  if (ext === 'ppt' || ext === 'pptx') return 'pptx'
  if (ext === 'doc' || ext === 'docx') return 'docx'
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return 'xlsx'
  return null
}

/** ZIP 容器魔数（PK\x03\x04）：pptx/docx 都是 zip 包；旧版 .ppt/.doc 二进制文件开头不是它 */
async function isZipContainer(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
}

export async function parseFile(file: File, onProgress?: (done: number, total: number) => void): Promise<ParseResult> {
  const source = detectSource(file.name)
  if (!source) throw new Error(`不支持的文件格式：${file.name}`)

  // 旧版二进制格式（.ppt/.doc）会被 detectSource 映射到新格式解析器，直接报莫名其妙的错——提前拦住，给出能操作的提示
  if ((source === 'pptx' || source === 'docx') && !(await isZipContainer(file))) {
    const ext = file.name.toLowerCase().split('.').pop()
    throw new Error(
      ext === 'ppt' || ext === 'doc'
        ? `「${file.name}」是旧版 .${ext} 格式，系统只认新格式：请用 WPS 或 Office 打开它，另存为 .${ext}x 后再导入`
        : `「${file.name}」打不开，文件可能已损坏`,
    )
  }

  let result: ParseResult = { drafts: [], reviews: [], skipped: [] }
  switch (source) {
    case 'pptx':
      result = await parsePptx(file, onProgress)
      break
    case 'docx':
      result = { drafts: await parseDocx(file), reviews: [], skipped: [] }
      break
    case 'xlsx':
      result = { drafts: await parseXlsx(file), reviews: [], skipped: [] }
      break
  }

  if (!result.drafts.length && !result.reviews.length) {
    throw new Error('未能从文件中识别出隐患问题或复查核销记录（仅支持含"不符合《…》/存在…风险"句式的通报页或规范台账表）')
  }
  return result
}

/**
 * 在 Web Worker 后台线程中解析（带逐页进度回调），主线程不被阻塞；
 * Worker 不可用时回退为当前线程解析。
 */
export function parseFileOffthread(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      resolve(parseFile(file, onProgress))
      return
    }
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data
      if (msg.type === 'progress') {
        onProgress?.(msg.done, msg.total)
      } else if (msg.type === 'done') {
        worker.terminate()
        resolve(msg.result as ParseResult)
      } else if (msg.type === 'error') {
        worker.terminate()
        reject(new Error(msg.message as string))
      }
    }
    worker.onerror = () => {
      worker.terminate()
      reject(new Error('解析线程异常'))
    }
    worker.postMessage({ file })
  })
}
