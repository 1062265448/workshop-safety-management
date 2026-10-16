import * as XLSX from 'xlsx'
import type { IssueDraft, RiskLevel } from '@/types'

// ─────────────────────────────────────────────────────────────
// XLSX 解析器（基础版）
// 适用：隐患台账表格，按表头名称映射字段
// 识别的表头：
//   标题 ← 标题/问题/隐患/隐患问题/问题描述(短)
//   描述 ← 描述/内容/详情/问题描述
//   区域 ← 区域/车间/地点/位置
//   类型 ← 类型/类别/分类
//   等级 ← 等级/风险等级
// ─────────────────────────────────────────────────────────────

const HEADER_MAP: Array<[RegExp, 'title' | 'description' | 'location' | 'category' | 'risk']> = [
  [/^(标题|问题|隐患|隐患问题|问题名称)$/, 'title'],
  [/^(描述|内容|详情|问题描述|隐患描述)$/, 'description'],
  [/^(区域|车间|地点|位置|部位)$/, 'location'],
  [/^(类型|类别|分类)$/, 'category'],
  [/^(等级|风险等级|风险)$/, 'risk'],
]

const RISK_FROM_TEXT: Record<string, RiskLevel> = { 一般: 'general', 重大: 'critical', 较大: 'general', 即知即改: 'immediate' }

export async function parseXlsx(file: File): Promise<IssueDraft[]> {
  const wb = XLSX.read(await file.arrayBuffer())
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
  if (!rows.length) return []

  // 表头映射
  const headers = Object.keys(rows[0])
  const fieldOf = (h: string) => HEADER_MAP.find(([re]) => re.test(h.trim()))?.[1]

  const drafts: IssueDraft[] = []
  rows.forEach((row, i) => {
    const d: Partial<Record<'title' | 'description' | 'location' | 'category' | 'risk', string>> = {}
    for (const h of headers) {
      const field = fieldOf(h)
      const v = String(row[h] ?? '').trim()
      if (field && v) d[field] = v
    }
    // 标题缺省时用描述截断
    if (!d.title && d.description) {
      d.title = d.description.length > 30 ? `${d.description.slice(0, 30)}…` : d.description
    }
    if (!d.title) return // 空行跳过
    drafts.push({
      key: `${file.name}-r${i}`,
      title: d.title,
      description: d.description ?? '',
      locationGuess: d.location,
      categoryGuess: d.category,
      riskLevel: (d.risk && RISK_FROM_TEXT[d.risk]) || 'general',
      accepted: true,
    })
  })
  return drafts
}
