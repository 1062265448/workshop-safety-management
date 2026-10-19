// ─────────────────────────────────────────────────────────────
// AI 预标注 + 范例学习 + 文字规范检查
// 原则二：AI 只负责「预判」，结果存 ai* 字段，不覆盖人工字段，人工确认才算数
// 原则三（防幻觉军规）：
//   1. title+description 合计少于 30 字的条目不送 AI，直接返回 {skipped:'too_short'}
//   2. 提示词写明「只依据给定文本判断，禁止编造事实，信息不足的字段返回 null」
//   3. 大模型返回非合法 JSON 时该条降级为 {error}，不中断整批
//   4. AI 返回的类型名不在系统现有标签树内的一律置 null（不采用幻觉类别）
// LLM 配置复用知识库模块（Setting 表 / 环境变量），不另搞一套
// ─────────────────────────────────────────────────────────────
import { Body, Controller, Delete, Get, Module, Param, Post } from '@nestjs/common'
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { PrismaService } from '../../prisma.service'
import { KnowledgeModule } from '../knowledge/knowledge.module'
import { LlmService, LlmConfig } from '../knowledge/llm.service'

// ── 类型 ─────────────────────────────────────────────────────

export interface PrelabelInput {
  title?: string
  description?: string
  workshop?: string
}

export interface PrelabelResult {
  categoryName: string | null
  riskLevel: string | null
  causeType: string | null
  countermeasureLevel: string | null
  suggestion: string | null
  /** 文本过短未送 AI */
  skipped?: 'too_short'
  /** 该条调用/解析失败（不中断整批） */
  error?: string
}

export interface StyleCheckResult {
  ok?: boolean
  problems?: string[]
  rewrite?: string
  skipped?: 'too_short'
}

const RISK_LEVELS = ['general', 'critical', 'immediate'] as const
const CAUSE_TYPES = ['system', 'individual'] as const
const CM_LEVELS = ['mechanism', 'technical', 'management'] as const

/** 防幻觉军规：title+description 合计不足 30 字不送 AI */
const MIN_PRELABEL_CHARS = 30
/** 文字规范检查：不足 10 字不送 AI */
const MIN_STYLE_CHARS = 10

/** 从模型输出里抠出第一段 JSON 对象（容忍前后多余文本）；失败返回 null */
function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function asText(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t ? t.slice(0, max) : null
}

@Injectable()
export class PrelabelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  private async requireConfig(): Promise<LlmConfig> {
    const cfg = await this.llm.getConfig()
    if (!cfg.apiKey) {
      throw new ServiceUnavailableException('未配置大模型 API Key：请先在知识库页「API 配置」中填写 DeepSeek Key')
    }
    return cfg
  }

  /** 调 OpenAI 兼容 chat 接口，返回文本内容；失败抛错由调用方降级 */
  private async chat(cfg: LlmConfig, system: string, user: string): Promise<string> {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!res.ok) throw new Error(`大模型接口错误 ${res.status}：${(await res.text()).slice(0, 200)}`)
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) throw new Error('大模型返回为空')
    return content
  }

  /** 隐患类型标签树（含子标签，显示为「父-子」）；返回展示名列表与 名称→展示名 映射 */
  private async categoryTree() {
    const tags = await this.prisma.tag.findMany({ where: { group: 'category' }, orderBy: { name: 'asc' } })
    const byParent = new Map<string | null, typeof tags>()
    for (const t of tags) {
      const key = t.parentId ?? null
      byParent.set(key, [...(byParent.get(key) ?? []), t])
    }
    const names: string[] = [] // 传给模型的展示名（子标签为 父-子）
    const displayOf = new Map<string, string>() // 标签原名 → 展示名
    for (const p of byParent.get(null) ?? []) {
      names.push(p.name)
      displayOf.set(p.name, p.name)
      for (const c of byParent.get(p.id) ?? []) {
        names.push(`${p.name}-${c.name}`)
        displayOf.set(c.name, `${p.name}-${c.name}`)
      }
    }
    return { names, displayOf }
  }

  /** 范例学习：每类取最近 3 条人工确认范例，拼进提示词对齐口径 */
  private async exampleBlock(): Promise<string> {
    const examples = await this.prisma.prelabelExample.findMany({ orderBy: { createdAt: 'desc' }, take: 200 })
    const byCat = new Map<string, typeof examples>()
    for (const e of examples) {
      const list = byCat.get(e.categoryName) ?? []
      if (list.length < 3) list.push(e) // 已按时间倒序，每类只留最近 3 条
      byCat.set(e.categoryName, list)
    }
    if (byCat.size === 0) return ''
    const lines = ['以下人工确认范例供对齐口径（判断时优先参考这些口径）：']
    for (const [cat, list] of byCat) {
      for (const e of list) {
        lines.push(`【范例 · ${cat}】标题：${e.title}${e.description ? `；描述：${e.description.slice(0, 120)}` : ''}`)
      }
    }
    return lines.join('\n')
  }

  /** AI 预标注：逐条调用，短文本跳过、单条失败不中断整批 */
  async prelabel(items: PrelabelInput[]): Promise<PrelabelResult[]> {
    const list = (items ?? []).slice(0, 50)
    if (!list.length) return []
    // 防幻觉军规 1：文本过短不送 AI（无需 Key 即可判定，整批都短时直接返回跳过）
    const skipped = list.map((item) => ((item.title ?? '').trim() + (item.description ?? '').trim()).replace(/\s+/g, '').length < MIN_PRELABEL_CHARS)
    const skipResult: PrelabelResult = { categoryName: null, riskLevel: null, causeType: null, countermeasureLevel: null, suggestion: null, skipped: 'too_short' }
    if (skipped.every(Boolean)) return list.map(() => ({ ...skipResult }))
    const cfg = await this.requireConfig()
    const { names, displayOf } = await this.categoryTree()
    const examples = await this.exampleBlock()
    const system = [
      '你是车间安全隐患预标注助手。只依据给定文本判断，禁止编造事实；信息不足的字段返回 null。',
      '输出严格 JSON，不要输出任何其他文字，格式：',
      '{"categoryName": 类型名或 null, "riskLevel": "general|critical|immediate" 或 null, "causeType": "system|individual" 或 null, "countermeasureLevel": "mechanism|technical|management" 或 null, "suggestion": "一句话整改建议" 或 null}',
      `隐患类型只能从以下现有类型中选（原样返回其中一个，禁止自创类型）：${names.length ? names.join('、') : '（系统暂无类型标签，categoryName 返回 null）'}`,
      'riskLevel 口径：immediate=即知即改（当场可改的小问题）；general=一般；critical=重大（可能直接导致人身/设备事故）。',
      'causeType 口径（戴明 94/6，约 94% 的问题出在系统）：system=系统原因（机制/流程/设备缺陷让人容易犯错）；individual=个人原因（明确是个人违章且机制无缺陷）。证据不足返回 null。',
      'countermeasureLevel 仅 causeType=system 时有意义，按 机制(mechanism) → 技术(technical) → 管理(management) 的顺序想：能靠制度/流程/检查机制解决的选机制，机制不行用技术（装置、防错），最后才是管理（培训、考核）；causeType 不是 system 时返回 null。',
      'suggestion 只写一句话整改建议，具体可检查；禁止"加强、尽快、适当、高度重视"这类无法检查的模糊词。',
      examples,
    ]
      .filter(Boolean)
      .join('\n')

    const results: PrelabelResult[] = []
    for (const item of list) {
      const title = (item.title ?? '').trim()
      const description = (item.description ?? '').trim()
      // 防幻觉军规 1：文本过短不送 AI
      if ((title + description).replace(/\s+/g, '').length < MIN_PRELABEL_CHARS) {
        results.push({ categoryName: null, riskLevel: null, causeType: null, countermeasureLevel: null, suggestion: null, skipped: 'too_short' })
        continue
      }
      try {
        const user = `车间/区域：${(item.workshop ?? '').trim() || '未知'}\n标题：${title}\n描述：${description || '（无）'}`
        const raw = await this.chat(cfg, system, user)
        const json = extractJson(raw)
        // 防幻觉军规 3：非合法 JSON 降级为 error，不中断整批
        if (!json) {
          results.push({ categoryName: null, riskLevel: null, causeType: null, countermeasureLevel: null, suggestion: null, error: 'AI 返回无法解析' })
          continue
        }
        const causeType = asEnum(json.causeType, CAUSE_TYPES)
        // 防幻觉军规 4：类型名必须在现有标签树内（子标签允许只回原名），否则置 null
        const rawCat = asText(json.categoryName, 60)
        const categoryName = rawCat && (names.includes(rawCat) || displayOf.has(rawCat)) ? rawCat : null
        results.push({
          categoryName,
          riskLevel: asEnum(json.riskLevel, RISK_LEVELS),
          causeType,
          countermeasureLevel: causeType === 'system' ? asEnum(json.countermeasureLevel, CM_LEVELS) : null,
          suggestion: asText(json.suggestion, 200),
        })
      } catch (e) {
        results.push({ categoryName: null, riskLevel: null, causeType: null, countermeasureLevel: null, suggestion: null, error: (e as Error).message })
      }
    }
    return results
  }

  /** 文字规范检查：按「谁、做什么、做到什么程度、何时完成」四要素检查，只改写不编造 */
  async styleCheck(text: string): Promise<StyleCheckResult> {
    const input = (text ?? '').trim()
    if (input.replace(/\s+/g, '').length < MIN_STYLE_CHARS) return { skipped: 'too_short' }
    const cfg = await this.requireConfig()
    const system = [
      '你是文字规范检查助手，检查整改要求/问题描述是否符合「谁、做什么、做到什么程度、何时完成」四要素，一句一事。',
      '特别拦截「加强、尽快、适当、高度重视」这类无法检查的模糊词，逐条指出。',
      '只依据给定文本判断，禁止编造事实：改写时不得添加原文没有的信息，缺的信息用【待补】占位。',
      '输出严格 JSON，不要输出任何其他文字，格式：{"ok": true|false, "problems": ["问题1", "问题2"], "rewrite": "规范改写稿"}',
      'ok=true 表示原文已符合四要素、无需改写，此时 problems 为空数组、rewrite 返回原文。',
    ].join('\n')
    try {
      const raw = await this.chat(cfg, system, `待检查文本：\n${input.slice(0, 1000)}`)
      const json = extractJson(raw)
      if (!json) throw new Error('AI 返回无法解析')
      const problems = Array.isArray(json.problems) ? json.problems.map((p) => asText(p, 200)).filter((p): p is string => !!p) : []
      return {
        ok: json.ok === true,
        problems,
        rewrite: asText(json.rewrite, 1000) ?? input,
      }
    } catch (e) {
      throw new ServiceUnavailableException(`规范检查失败：${(e as Error).message}`)
    }
  }

  // ── 范例学习（PrelabelExample） ────────────────────────────

  async addExample(body: { categoryName?: string; title?: string; description?: string }) {
    const categoryName = (body.categoryName ?? '').trim()
    const title = (body.title ?? '').trim()
    if (!categoryName || !title) throw new BadRequestException('categoryName 与 title 必填')
    return this.prisma.prelabelExample.create({
      data: { categoryName, title: title.slice(0, 200), description: (body.description ?? '').trim().slice(0, 500) },
    })
  }

  listExamples() {
    return this.prisma.prelabelExample.findMany({ orderBy: { createdAt: 'desc' }, take: 200 })
  }

  async removeExample(id: string) {
    await this.prisma.prelabelExample.delete({ where: { id } }).catch(() => undefined)
    return { ok: true }
  }

  /**
   * 人工改动率：AI 预判与人工最终判定对比。
   * total = 有 AI 预填的条数；changed = 人工类别与 aiCategory 不一致的条数
   * （人工未分类的无法比较，不计入 changed）。
   */
  async stats() {
    const issues = await this.prisma.issue.findMany({
      where: {
        deletedAt: null,
        OR: [{ aiCategory: { not: null } }, { aiRiskLevel: { not: null } }, { aiCauseType: { not: null } }, { aiSuggestion: { not: null } }],
      },
      select: { aiCategory: true, categoryId: true },
    })
    const tagIds = [...new Set(issues.map((i) => i.categoryId).filter((x): x is string => !!x))]
    const tags = tagIds.length ? await this.prisma.tag.findMany({ where: { id: { in: tagIds } } }) : []
    const tagName = new Map(tags.map((t) => [t.id, t.name]))
    let changed = 0
    for (const i of issues) {
      if (!i.aiCategory) continue
      const human = i.categoryId ? tagName.get(i.categoryId) : undefined
      if (human && human !== i.aiCategory) changed++
    }
    return { total: issues.length, changed, rate: issues.length ? changed / issues.length : 0 }
  }
}

@Controller('issues')
export class PrelabelController {
  constructor(private readonly svc: PrelabelService) {}

  /** AI 预标注：批量导入暂存区场景，逐条返回（短文本 skipped、失败 error，不中断整批） */
  @Post('prelabel')
  prelabel(@Body() body: { items?: PrelabelInput[] }) {
    return this.svc.prelabel(body?.items ?? [])
  }

  /** 设为 AI 范例（已复核且已分类的隐患，由前端带人工确认的类型名提交） */
  @Post('prelabel/examples')
  addExample(@Body() body: { categoryName?: string; title?: string; description?: string }) {
    return this.svc.addExample(body ?? {})
  }

  @Get('prelabel/examples')
  listExamples() {
    return this.svc.listExamples()
  }

  @Delete('prelabel/examples/:id')
  removeExample(@Param('id') id: string) {
    return this.svc.removeExample(id)
  }

  /** 人工改动率：改动率高说明 AI 口径与人工偏差大，可多设范例 */
  @Get('prelabel/stats')
  stats() {
    return this.svc.stats()
  }

  /** 文字规范检查（四要素 + 模糊词拦截，只改写不编造） */
  @Post('style-check')
  styleCheck(@Body() body: { text?: string }) {
    return this.svc.styleCheck(body?.text ?? '')
  }
}

@Module({
  imports: [KnowledgeModule],
  controllers: [PrelabelController],
  providers: [PrelabelService, PrismaService],
})
export class PrelabelModule {}
