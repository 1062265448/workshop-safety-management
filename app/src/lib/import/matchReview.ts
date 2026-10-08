import type { ReviewDraft, SafetyIssue, Tag } from '@/types'

// ─────────────────────────────────────────────────────────────
// 复查核销匹配器
// 通报复查页引述原问题片段（"…第522期「9月18日23:01分检查熔铸车间，
// 侧吹熔铸炉蒸汽风机区域…跨接线均缺失…」的问题。经查，整改核销属实。"），
// 这里按「车间一致 + 描述片段字符重合度」在库中未闭环隐患里找对应项
// ─────────────────────────────────────────────────────────────

/** 归一化：去标点空白，只留有效字符 */
function normalize(s: string): string {
  return s.replace(/[\s，。、；：""''《》（）()·…—\-—"']/g, '')
}

/** 字符 bigram 集合 */
function bigrams(s: string): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}

/** 片段覆盖率：snippet 的 bigram 有多少出现在目标文本中（0~1） */
function coverage(snippet: string, target: string): number {
  const a = bigrams(normalize(snippet))
  if (!a.size) return 0
  const t = normalize(target)
  let hit = 0
  for (const g of a) if (t.includes(g)) hit++
  return hit / a.size
}

export interface ReviewMatch {
  issueId: string
  issueTitle: string
  score: number
}

/**
 * 为一条复查记录找最佳匹配隐患
 * @param review 复查草稿（snippet / workshop）
 * @param openIssues 库中未闭环隐患
 * @param tags 标签库（取区域名用）
 * @returns 命中（覆盖率达阈值且车间一致）或 undefined
 */
export function matchReview(
  review: Pick<ReviewDraft, 'snippet' | 'workshop'>,
  openIssues: SafetyIssue[],
  tags: Tag[],
): ReviewMatch | undefined {
  if (!review.snippet || review.snippet.length < 6) return undefined
  const locationName = (i: SafetyIssue) => tags.find((t) => t.id === i.locationId)?.name

  let best: ReviewMatch | undefined
  for (const issue of openIssues) {
    const text = `${issue.title}\n${issue.description}`
    const score = coverage(review.snippet, text)
    if (score < 0.45) continue
    // 双方都识别出车间时必须一致，防止不同车间的相似描述误核销
    const ws = locationName(issue)
    if (review.workshop && ws && review.workshop !== ws) continue
    if (!best || score > best.score) best = { issueId: issue.id, issueTitle: issue.title, score }
  }
  return best
}
