// ─────────────────────────────────────────────────────────────
// 大模型服务（预留接口）：OpenAI 兼容协议，默认指向 DeepSeek
// 配置方式（backend/.env 或容器环境变量）：
//   LLM_API_KEY=sk-xxx            未配置时 AI 回答功能优雅降级
//   LLM_BASE_URL=https://api.deepseek.com/v1
//   LLM_MODEL=deepseek-chat       DeepSeek-V4 发布后改此变量即可切换
// ─────────────────────────────────────────────────────────────
import { Injectable } from '@nestjs/common'

const LLM_API_KEY = process.env.LLM_API_KEY ?? ''
const LLM_BASE_URL = (process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/$/, '')
const LLM_MODEL = process.env.LLM_MODEL ?? 'deepseek-chat'

export interface KnowledgeHit {
  docId: string
  kind: string
  title: string
  content: string
  score: number
}

@Injectable()
export class LlmService {
  get configured(): boolean {
    return !!LLM_API_KEY
  }

  get model(): string {
    return LLM_MODEL
  }

  /** 基于检索到的知识片段生成回答；未配置 API Key 时返回 null，由调用方降级 */
  async answer(question: string, hits: KnowledgeHit[]): Promise<string | null> {
    if (!this.configured) return null
    const context = hits
      .map((h, i) => `【资料${i + 1}】（${h.title}，相似度 ${(h.score * 100).toFixed(0)}%）\n${h.content}`)
      .join('\n\n')
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              '你是成品车间的安全知识助手。只能依据给出的资料回答，资料里没有的就说"知识库中暂无相关记录"，不要编造。' +
              '回答用口语化中文，简洁直接；引用资料时标注【资料N】。涉及整改期限、风险等级等制度性内容时严格按资料原文。',
          },
          { role: 'user', content: `资料如下：\n\n${context}\n\n问题：${question}` },
        ],
      }),
    })
    if (!res.ok) throw new Error(`大模型接口错误 ${res.status}：${(await res.text()).slice(0, 200)}`)
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content?.trim() || null
  }
}
