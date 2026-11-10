// ─────────────────────────────────────────────────────────────
// 大模型服务：OpenAI 兼容协议，默认指向 DeepSeek
// 配置优先级：数据库 settings 表（页面「API 配置」入口）> 环境变量
//   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
// 未配置 Key 时 AI 回答优雅降级为纯检索
// DeepSeek-V4 发布后改 model 配置即可切换，无需改代码
// ─────────────────────────────────────────────────────────────
import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from 'crypto'
import { PrismaService } from '../../prisma.service'

export interface LlmConfig {
  apiKey: string
  baseUrl: string
  model: string
}

/** OpenAI 兼容接口地址：Kimi Code 的 /coding 基础地址必须补全 /v1。 */
export function chatCompletionsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (normalized.endsWith('/chat/completions')) return normalized
  try {
    const url = new URL(normalized)
    if (['api.kimi.com', 'api.kimi.ai'].includes(url.hostname) && /^\/coding(?:\/v1)?$/.test(url.pathname)) {
      url.pathname = `${url.pathname.replace(/\/v1$/, '')}/v1/chat/completions`
      return url.toString()
    }
  } catch {
    // 地址合法性由配置页面校验；此处保留原有的错误提示路径。
  }
  return `${normalized}/chat/completions`
}

/** kimi-for-coding 当前只接受 temperature=1，其余模型沿用各业务场景的默认值。 */
export function modelTemperature(model: string, fallback: number): number {
  return model.trim() === 'kimi-for-coding' ? 1 : fallback
}

export interface ModelProfileInput {
  name?: string
  baseUrl?: string
  model?: string
  apiKey?: string
}

interface StoredModelProfile {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKey: string
  createdAt: string
  updatedAt: string
  lastUsedAt: string
}

export interface ModelProfileView {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKeySet: boolean
  active: boolean
  lastUsedAt: string
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
const KEY_PROFILES = 'llm_model_profiles_v1'
const KEY_ACTIVE_PROFILE = 'llm_active_model_profile_v1'
const ENC_PREFIX = 'enc:v1'
const ENC_AAD = Buffer.from('wsms:llm_api_key:v1')

function encryptionKeyError(): ServiceUnavailableException {
  return new ServiceUnavailableException('保存或读取加密的 LLM API Key 需要配置至少 32 字节的 SETTINGS_ENCRYPTION_KEY')
}

/** 支持 64+ 位 hex、32+ 字节 base64，或以 scrypt 派生普通长 passphrase。 */
export function deriveSettingsEncryptionKey(raw = process.env.SETTINGS_ENCRYPTION_KEY): Buffer {
  const value = raw?.trim() ?? ''
  if (!value) throw encryptionKeyError()

  let material: Buffer
  let passphrase = false
  const explicitHex = value.startsWith('hex:')
  const explicitBase64 = value.startsWith('base64:')
  const encoded = explicitHex || explicitBase64 ? value.slice(value.indexOf(':') + 1) : value
  if (explicitHex || (!explicitBase64 && /^[0-9a-fA-F]{64,}$/.test(encoded) && encoded.length % 2 === 0)) {
    if (!/^[0-9a-fA-F]+$/.test(encoded) || encoded.length % 2 !== 0) throw encryptionKeyError()
    material = Buffer.from(encoded, 'hex')
  } else if (explicitBase64 || /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    const normalized = encoded.replace(/=+$/, '')
    material = Buffer.from(encoded, 'base64')
    const canonicalBase64 = material.toString('base64').replace(/=+$/, '') === normalized
    // 无前缀时，只有解码后至少 32 字节才按 base64 处理；32 位纯字母口令仍走 scrypt。
    if (explicitBase64 ? !canonicalBase64 : !canonicalBase64 || material.length < 32) {
      if (explicitBase64) throw encryptionKeyError()
      material = Buffer.from(value, 'utf8')
      passphrase = true
    }
  } else {
    material = Buffer.from(value, 'utf8')
    passphrase = true
  }
  if (material.length < 32) throw encryptionKeyError()
  // hex/base64 是密钥材料，统一压缩到 256 位；普通口令使用带域分隔盐的 scrypt。
  return passphrase ? scryptSync(value, 'wsms-settings-encryption-v1', 32) : createHash('sha256').update(material).digest()
}

export function encryptSettingsValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(ENC_AAD)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`
}

export function decryptSettingsValue(stored: string, key: Buffer): string {
  const parts = stored.split(':')
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') throw new Error('LLM API Key 密文格式无效')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64url'))
    decipher.setAAD(ENC_AAD)
    decipher.setAuthTag(Buffer.from(parts[3], 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('LLM API Key 解密失败，请核对 SETTINGS_ENCRYPTION_KEY')
  }
}

@Injectable()
export class LlmService {
  constructor(private readonly prisma: PrismaService) {}

  /** 读取生效配置（库 > 环境变量 > 默认）；enc:v1 解密，历史明文仅兼容读取。 */
  async getConfig(): Promise<LlmConfig> {
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: [KEY_APIKEY, KEY_BASEURL, KEY_MODEL] } },
    })
    const map = new Map(rows.map((r) => [r.key, r.value]))
    const storedKey = map.get(KEY_APIKEY) || ''
    const apiKey = storedKey.startsWith(`${ENC_PREFIX}:`)
      ? decryptSettingsValue(storedKey, deriveSettingsEncryptionKey())
      : storedKey || process.env.LLM_API_KEY || ''
    return {
      apiKey,
      baseUrl: (map.get(KEY_BASEURL) || process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
      model: map.get(KEY_MODEL) || process.env.LLM_MODEL || 'deepseek-chat',
    }
  }

  private putSetting(key: string, value: string) {
    return this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }

  private async readProfiles(): Promise<StoredModelProfile[]> {
    const row = await this.prisma.setting.findUnique({ where: { key: KEY_PROFILES } })
    if (!row?.value) return []
    const parsed = JSON.parse(row.value) as unknown
    if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object')) {
      throw new ServiceUnavailableException('历史模型方案数据格式无效，请联系管理员检查配置')
    }
    return parsed as StoredModelProfile[]
  }

  private writeProfiles(profiles: StoredModelProfile[]) {
    return this.putSetting(KEY_PROFILES, JSON.stringify(profiles))
  }

  /** 首次使用方案管理时，把当前生效配置原样保留为第一个历史方案。 */
  private async ensureProfiles(current?: LlmConfig) {
    const existing = await this.readProfiles()
    if (existing.length) return existing
    const config = current ?? await this.getConfig()
    const now = new Date().toISOString()
    const profile: StoredModelProfile = {
      id: randomUUID(),
      name: config.model || '当前模型',
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey ? encryptSettingsValue(config.apiKey, deriveSettingsEncryptionKey()) : '',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    }
    await this.writeProfiles([profile])
    await this.putSetting(KEY_ACTIVE_PROFILE, profile.id)
    return [profile]
  }

  async getConfigView() {
    const [config, profiles, activeRow] = await Promise.all([
      this.getConfig(),
      this.readProfiles(),
      this.prisma.setting.findUnique({ where: { key: KEY_ACTIVE_PROFILE } }),
    ])
    const matched = profiles.find((profile) => profile.baseUrl === config.baseUrl && profile.model === config.model)
    const activeId = profiles.some((profile) => profile.id === activeRow?.value) ? activeRow!.value : matched?.id ?? null
    const views: ModelProfileView[] = profiles.length ? profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKeySet: !!profile.apiKey,
      active: profile.id === activeId,
      lastUsedAt: profile.lastUsedAt,
    })) : [{
      id: 'current', name: config.model || '当前模型', baseUrl: config.baseUrl, model: config.model,
      apiKeySet: !!config.apiKey, active: true, lastUsedAt: '',
    }]
    return {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeySet: !!config.apiKey,
      activeProfileId: activeId ?? 'current',
      profiles: views,
    }
  }

  /** 新 Key 在创建任何数据库操作前完成加密，缺少密钥时明确失败且不落明文。 */
  async saveConfig(input: { name?: string; apiKey?: string; baseUrl?: string; model?: string; clearApiKey?: boolean }, syncProfile = true) {
    const plainKey = !input.clearApiKey && input.apiKey !== undefined ? input.apiKey.trim() : ''
    const encryptedKey = plainKey ? encryptSettingsValue(plainKey, deriveSettingsEncryptionKey()) : ''
    const current = syncProfile ? await this.getConfig() : null
    const profiles = syncProfile ? await this.readProfiles() : []
    const activeRow = syncProfile ? await this.prisma.setting.findUnique({ where: { key: KEY_ACTIVE_PROFILE } }) : null
    const ops: Promise<unknown>[] = []
    if (input.clearApiKey) ops.push(this.putSetting(KEY_APIKEY, ''))
    else if (plainKey) ops.push(this.putSetting(KEY_APIKEY, encryptedKey))
    if (input.baseUrl !== undefined) ops.push(this.putSetting(KEY_BASEURL, input.baseUrl.trim().replace(/\/$/, '')))
    if (input.model !== undefined) ops.push(this.putSetting(KEY_MODEL, input.model.trim()))

    if (syncProfile && profiles.length && current) {
      const activeId = activeRow?.value || profiles.find((profile) => profile.baseUrl === current.baseUrl && profile.model === current.model)?.id
      const active = profiles.find((profile) => profile.id === activeId)
      if (active) {
        if (input.name !== undefined && input.name.trim()) active.name = input.name.trim()
        if (input.baseUrl !== undefined) active.baseUrl = input.baseUrl.trim().replace(/\/$/, '')
        if (input.model !== undefined) active.model = input.model.trim()
        if (input.clearApiKey) active.apiKey = ''
        else if (plainKey) active.apiKey = encryptedKey
        active.updatedAt = new Date().toISOString()
        ops.push(this.writeProfiles(profiles))
      }
    }
    await Promise.all(ops)
  }

  async addProfile(input: ModelProfileInput) {
    const baseUrl = input.baseUrl?.trim().replace(/\/$/, '') ?? ''
    const model = input.model?.trim() ?? ''
    if (!baseUrl || !model) throw new BadRequestException('请填写完整的接口地址和模型名称')
    const current = await this.getConfig()
    const plainKey = input.apiKey?.trim() || current.apiKey
    const encryptedKey = plainKey ? encryptSettingsValue(plainKey, deriveSettingsEncryptionKey()) : ''
    const profiles = await this.ensureProfiles(current)
    const now = new Date().toISOString()
    const profile: StoredModelProfile = {
      id: randomUUID(),
      name: input.name?.trim() || model,
      baseUrl,
      model,
      apiKey: encryptedKey,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    }
    await this.writeProfiles([...profiles, profile])
    await this.activateProfile(profile.id)
  }

  async activateProfile(id: string) {
    const profiles = await this.readProfiles()
    const profile = profiles.find((item) => item.id === id)
    if (!profile) throw new NotFoundException('模型方案不存在或已删除')
    const plainKey = profile.apiKey.startsWith(`${ENC_PREFIX}:`)
      ? decryptSettingsValue(profile.apiKey, deriveSettingsEncryptionKey())
      : profile.apiKey
    await this.saveConfig({ apiKey: plainKey || undefined, clearApiKey: !plainKey, baseUrl: profile.baseUrl, model: profile.model }, false)
    profile.lastUsedAt = new Date().toISOString()
    await this.putSetting(KEY_ACTIVE_PROFILE, id)
    await this.writeProfiles(profiles)
  }

  async deleteProfile(id: string) {
    const [profiles, activeRow, current] = await Promise.all([
      this.readProfiles(),
      this.prisma.setting.findUnique({ where: { key: KEY_ACTIVE_PROFILE } }),
      this.getConfig(),
    ])
    const profile = profiles.find((item) => item.id === id)
    if (!profile) throw new NotFoundException('模型方案不存在或已删除')
    const active = activeRow?.value === id || (!activeRow?.value && profile.baseUrl === current.baseUrl && profile.model === current.model)
    if (active) throw new BadRequestException('使用中的模型方案不能删除，请先切换到其他方案')
    await this.writeProfiles(profiles.filter((item) => item.id !== id))
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
    const res = await fetch(chatCompletionsEndpoint(cfg.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: modelTemperature(cfg.model, 0.2),
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
