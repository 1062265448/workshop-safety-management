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

export async function parseFile(file: File): Promise<ParseResult> {
  const source = detectSource(file.name)
  if (!source) throw new Error(`不支持的文件格式：${file.name}`)

  let result: ParseResult = { drafts: [], reviews: [], skipped: [] }
  switch (source) {
    case 'pptx':
      result = await parsePptx(file)
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
