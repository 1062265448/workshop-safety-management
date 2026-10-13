// ─────────────────────────────────────────────────────────────
// 大模型服务：OpenAI 兼容协议，默认指向 DeepSeek
// 配置优先级：数据库 settings 表（页面「API 配置」入口）> 环境变量
//   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
// 未配置 Key 时 AI 回答优雅降级为纯检索
// DeepSeek-V4 发布后改 model 配置即可切换，无需改代码
// ─────────────────────────────────────────────────────────────
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma.service'

export interface LlmConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export interface KnowledgeHit {
  docId: string
  kind: string
  title: string
  content: string
  score: number
}

const KEY_APIKEY = 'llm_api_key'
const KEY_BASEURL = 'llm_base_url'
const KEY_MODEL = 'llm_model'

@Injectable()
export class LlmService {
  constructor(private readonly prisma: PrismaService) {}

  /** 读取生效配置（库 > 环境变量 > 默认） */
  async getConfig(): Promise<LlmConfig> {
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: [KEY_APIKEY, KEY_BASEURL, KEY_MODEL] } },
    })
    const map = new Map(rows.map((r) => [r.key, r.value]))
    return {
      apiKey: map.get(KEY_APIKEY) || process.env.LLM_API_KEY || '',
      baseUrl: (map.get(KEY_BASEURL) || process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
      model: map.get(KEY_MODEL) || process.env.LLM_MODEL || 'deepseek-chat',
    }
  }

  /** 页面保存配置：只更新提供的字段；apiKey 留空表示不改动，clearApiKey 表示清除 */
  async saveConfig(input: { apiKey?: string; baseUrl?: string; model?: string; clearApiKey?: boolean }) {
    const ops: Promise<unknown>[] = []
    const put = (key: string, value: string) =>
      this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    if (input.clearApiKey) ops.push(put(KEY_APIKEY, ''))
    else if (input.apiKey !== undefined && input.apiKey !== '') ops.push(put(KEY_APIKEY, input.apiKey.trim()))
    if (input.baseUrl !== undefined) ops.push(put(KEY_BASEURL, input.baseUrl.trim()))
    if (input.model !== undefined) ops.push(put(KEY_MODEL, input.model.trim()))
    await Promise.all(ops)
  }

  async isConfigured(): Promise<boolean> {
    return !!(await this.getConfig()).apiKey
  }

  /** 基于检索到的知识片段生成回答；未配置 API Key 时返回 null，由调用方降级 */
  async answer(question: string, hits: KnowledgeHit[]): Promise<string | null> {
    const cfg = await this.getConfig()
    if (!cfg.apiKey) return null
    const context = hits
      .map((h, i) => `【资料${i + 1}】（${h.title}，相似度 ${(h.score * 100).toFixed(0)}%）\n${h.content}`)
      .join('\n\n')
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
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
