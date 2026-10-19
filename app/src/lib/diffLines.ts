// ─────────────────────────────────────────────────────────────
// 逐行 diff：LCS（最长公共子序列）对齐两份文本的行，
// 输出 新增/删除/未变 三类行，用于知识库版本对比
// ─────────────────────────────────────────────────────────────

export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

/** 逐行对比 oldText → newText（按 \n 切行；空文本按 0 行处理） */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText ? oldText.split('\n') : []
  const b = newText ? newText.split('\n') : []
  const m = a.length
  const n = b.length
  if (m === 0 && n === 0) return []

  // LCS 动态规划表：dp[i][j] = a[i:] 与 b[j:] 的最长公共子序列长度
  // 行数过大时退化为简单对齐（知识库文档一般几百行，O(m*n) 足够）
  const MAX = 2000
  if (m > MAX || n > MAX) {
    return [...a.map((text): DiffLine => ({ type: 'del', text })), ...b.map((text): DiffLine => ({ type: 'add', text }))]
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i++
    } else {
      out.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] })
  while (j < n) out.push({ type: 'add', text: b[j++] })
  return out
}
