import mammoth from 'mammoth'
import type { IssueDraft, RiskLevel } from '@/types'

// ─────────────────────────────────────────────────────────────
// DOCX 解析器（基础版）
// 适用：检查记录 / 隐患清单类 Word 文档
// 规则：按段落拆分，含"不符合《/存在…风险/隐患"的段落识别为一条问题
// ─────────────────────────────────────────────────────────────

const PROBLEM_RE = /不符合《|存在[^。]{0,40}(风险|隐患)/
const MAJOR_RE = /红区|高处|吊装|动火|受限空间|临时用电|交叉作业|未加装|未采取|失效|断裂/

function guessRisk(text: string): RiskLevel {
  if (/重大|红区|火灾|爆炸/.test(text)) return 'critical'
  if (MAJOR_RE.test(text)) return 'major'
  return 'general'
}

export async function parseDocx(file: File): Promise<IssueDraft[]> {
  const arrayBuffer = await file.arrayBuffer()
  const { value } = await mammoth.extractRawText({ arrayBuffer })
  const paras = value.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length >= 8)

  return paras
    .filter((p) => PROBLEM_RE.test(p))
    .map((p, i) => {
      const firstSentence = (p.split('。')[0] ?? p).trim()
      return {
        key: `${file.name}-p${i}`,
        title: firstSentence.length > 30 ? `${firstSentence.slice(0, 30)}…` : firstSentence,
        description: p,
        riskLevel: guessRisk(p),
        accepted: true,
      }
    })
}
