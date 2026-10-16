// ─────────────────────────────────────────────────────────────
// 知识库模块：把存量业务数据（隐患/参考标注/督查通报）向量化入库，
// 提供语义检索 + AI 问答（LLM 未配置 Key 时只返回检索结果）
// 重建索引为后台任务：POST /reindex 立即返回，GET /reindex/status 轮询进度
// ─────────────────────────────────────────────────────────────
import { Body, Controller, Get, Module, Post, Put, Query } from '@nestjs/common'
import { Injectable, BadRequestException } from '@nestjs/common'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { PrismaService } from '../../prisma.service'
import { EmbeddingService } from './embedding.service'
import { LlmService, KnowledgeHit } from './llm.service'
import { Roles } from '../auth/auth.module'

const BULLETIN_DIR = resolve(process.env.BULLETIN_DIR || join(process.cwd(), '..', '厂督察通报'))
// 嵌入批大小：一次推理 16 段，比逐段调用快约一个数量级
const EMBED_BATCH = 16

interface DocDraft {
  kind: string
  refId: string | null
  title: string
  source: string
  chunks: string[]
}

export interface ReindexJob {
  running: boolean
  total: number
  done: number
  docs: number
  error: string
  finishedAt: string | null
}

// 按句/按行切分长文本为 ≤400 字的切片（50 字重叠保持上下文连贯）
function splitText(text: string, max = 400, overlap = 50): string[] {
  if (text.length <= max) return [text]
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + max, text.length)
    if (end < text.length) {
      // 尽量在句号/换行处断开，避免切断句子
      const window = text.slice(start + Math.floor(max * 0.6), end)
      const breakAt = Math.max(window.lastIndexOf('。'), window.lastIndexOf('\n'), window.lastIndexOf('；'))
      if (breakAt > 0) end = start + Math.floor(max * 0.6) + breakAt + 1
    }
    parts.push(text.slice(start, end).trim())
    start = end - overlap
    if (start >= text.length - overlap) break
  }
  return parts.filter((p) => p.length >= 20)
}

// 督查通报 pptx：zip 解包后从 slide XML 提取纯文本（无需前端解析器，原始文本即可入库）
async function extractPptxSlides(filePath: string): Promise<string[]> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(readFileSync(filePath))
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/slide(\d+)/)![1]) - Number(b.match(/slide(\d+)/)![1]))
  const slides: string[] = []
  for (const name of slideNames) {
    const xml = await zip.files[name].async('string')
    const text = xml
      .replace(/<a:br\s*\/>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (text.length >= 20) slides.push(text)
  }
  return slides
}

// 字符二元组集合（中文按字切，专名/术语重叠用 Jaccard 衡量）
function bigrams(s: string): Set<string> {
  const clean = (s ?? '').replace(/\s+/g, '')
  const set = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

@Injectable()
export class KnowledgeService {
  private job: ReindexJob = { running: false, total: 0, done: 0, docs: 0, error: '', finishedAt: null }

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
    private readonly llm: LlmService,
  ) {}

  async status() {
    const [docs, chunks, llmConfigured] = await Promise.all([
      this.prisma.knowledgeDoc.count(),
      this.prisma.knowledgeChunk.count(),
      this.llm.isConfigured(),
    ])
    const byKind = await this.prisma.knowledgeDoc.groupBy({ by: ['kind'], _count: true })
    return {
      modelReady: this.embedding.ready,
      modelDir: this.embedding.modelDir,
      bulletinDir: BULLETIN_DIR,
      bulletinDirExists: existsSync(BULLETIN_DIR),
      llm: { configured: llmConfigured, model: (await this.llm.getConfig()).model },
      docs,
      chunks,
      byKind: Object.fromEntries(byKind.map((k) => [k.kind, k._count])),
    }
  }

  /** 汇总待入库文档：历史隐患（含整改记录与参考标注）+ 督查通报原文 */
  private async collectDocs(): Promise<DocDraft[]> {
    const drafts: DocDraft[] = []

    // 1. 隐患案例库（最有价值：每条都带整改措施与复查记录）
    const [issues, tags, annotations] = await Promise.all([
      this.prisma.issue.findMany({ where: { deletedAt: null }, orderBy: { foundAt: 'desc' } }),
      this.prisma.tag.findMany(),
      this.prisma.issueAnnotation.findMany(),
    ])
    const tagName = new Map(tags.map((t) => [t.id, t.name]))
    const annByIssue = new Map(annotations.map((a) => [a.issueId, a]))
    const RISK: Record<string, string> = { general: '一般', major: '较大', critical: '重大' }
    const STATUS: Record<string, string> = { pending: '待整改', fixing: '整改中', review: '复查中', closed: '已闭环' }
    for (const issue of issues) {
      const lines = [
        `标题：${issue.title}`,
        `车间/区域：${issue.locationId ? tagName.get(issue.locationId) ?? '' : '未标注'}`,
        `类型：${issue.categoryId ? tagName.get(issue.categoryId) ?? '' : '未标注'}`,
        `风险等级：${RISK[issue.riskLevel] ?? issue.riskLevel}，状态：${STATUS[issue.status] ?? issue.status}`,
        `发现时间：${issue.foundAt.toISOString().slice(0, 10)}`,
        issue.description && `问题描述：${issue.description}`,
        issue.fixNote && `整改措施：${issue.fixNote}`,
        issue.rechecks.length > 0 && `复查记录：共复查 ${issue.rechecks.length} 次`,
      ]
      const ann = annByIssue.get(issue.id)
      if (ann && (ann.similarity || ann.caution)) {
        lines.push(`对成品车间的参考意义：${ann.similarity || '无'}；需严格注意：${ann.caution || '无'}`)
      }
      drafts.push({
        kind: 'issue',
        refId: issue.id,
        title: issue.title,
        source: `${issue.scope === 'managed' ? '成品车间' : '其他车间通报'} · ${issue.source === 'manual' ? '手动录入' : issue.sourceFile ?? issue.source}`,
        chunks: splitText(lines.filter(Boolean).join('\n')),
      })
    }

    // 2. 督查通报原件（厂督察通报目录下的 pptx，按页切片）
    if (existsSync(BULLETIN_DIR)) {
      for (const file of readdirSync(BULLETIN_DIR).filter((f) => f.toLowerCase().endsWith('.pptx'))) {
        try {
          const slides = await extractPptxSlides(join(BULLETIN_DIR, file))
          const chunks = slides.flatMap((s) => splitText(s))
          if (chunks.length > 0) {
            drafts.push({ kind: 'bulletin', refId: null, title: file.replace(/\.pptx$/i, ''), source: file, chunks })
          }
        } catch (e) {
          console.warn(`[knowledge] 通报解析失败 ${file}:`, (e as Error).message)
        }
      }
    }
    return drafts
  }

  /** 启动后台全量重建（管理员操作）；已在运行则直接返回当前进度 */
  startReindex(): ReindexJob {
    if (this.job.running) return this.job
    if (!this.embedding.ready) throw new BadRequestException(`嵌入模型文件缺失：${this.embedding.modelDir}`)
    this.job = { running: true, total: 0, done: 0, docs: 0, error: '', finishedAt: null }
    // 不 await：后台跑，前端轮询 /reindex/status
    void this.runReindex().catch((e) => {
      this.job.error = (e as Error).message
      this.job.running = false
      this.job.finishedAt = new Date().toISOString()
    })
    return this.job
  }

  reindexStatus(): ReindexJob {
    return this.job
  }

  private async runReindex() {
    const drafts = await this.collectDocs()
    this.job.docs = drafts.length

    // 先清后建，保证与业务数据一致；文档记录快速落库
    await this.prisma.knowledgeDoc.deleteMany() // chunks 级联删除
    const flat: { docId: string; seq: number; content: string }[] = []
    for (const draft of drafts) {
      const doc = await this.prisma.knowledgeDoc.create({
        data: { kind: draft.kind, refId: draft.refId, title: draft.title, source: draft.source },
      })
      draft.chunks.forEach((content, seq) => flat.push({ docId: doc.id, seq, content }))
    }
    this.job.total = flat.length

    // 批量嵌入 + 批量写库
    for (let i = 0; i < flat.length; i += EMBED_BATCH) {
      const batch = flat.slice(i, i + EMBED_BATCH)
      const vectors = await this.embedding.embed(batch.map((b) => b.content))
      for (let j = 0; j < batch.length; j++) {
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO knowledge_chunks (id, "docId", seq, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)`,
          `kc_${batch[j].docId}_${batch[j].seq}`,
          batch[j].docId,
          batch[j].seq,
          batch[j].content,
          `[${vectors[j].join(',')}]`,
        )
      }
      this.job.done = Math.min(i + EMBED_BATCH, flat.length)
    }
    this.job.running = false
    this.job.finishedAt = new Date().toISOString()
  }

  /** 语义检索：余弦距离取 top N */
  async search(q: string, limit = 8): Promise<KnowledgeHit[]> {
    const query = (q ?? '').trim()
    if (!query) return []
    const [vec] = await this.embedding.embed([query], true)
    const rows = await this.prisma.$queryRawUnsafe<
      { docId: string; kind: string; title: string; content: string; score: number }[]
    >(
      `SELECT c."docId", d.kind, d.title, c.content,
              1 - (c.embedding <=> $1::vector) AS score
       FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c."docId"
       WHERE c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2`,
      `[${vec.join(',')}]`,
      Math.min(Math.max(limit, 1), 20),
    )
    return rows.map((r) => ({ ...r, score: Number(r.score) }))
  }

  /** 向量近邻候选（仅案例库，取前 12 条切片） */
  private async issueCandidates(vec: number[]) {
    return this.prisma.$queryRawUnsafe<
      { issueId: string | null; title: string; content: string; score: number }[]
    >(
      `SELECT d."refId" AS "issueId", d.title, c.content,
              1 - (c.embedding <=> $1::vector) AS score
       FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c."docId"
       WHERE c.embedding IS NOT NULL AND d.kind = 'issue'
       ORDER BY c.embedding <=> $1::vector
       LIMIT 12`,
      `[${vec.join(',')}]`,
    )
  }

  /** 混合打分：0.65×向量余弦 + 0.35×标题/内容字符二元组 Jaccard（标题权重更高），按隐患去重 */
  private hybridRank(
    query: string,
    vec: number[],
    rows: { issueId: string | null; title: string; content: string; score: number }[],
    limit: number,
  ) {
    const qBi = bigrams(query)
    const best = new Map<string, { issueId: string; title: string; score: number; vec: number; snippet: string }>()
    for (const r of rows) {
      if (!r.issueId) continue
      const vecScore = Number(r.score)
      const cur = best.get(r.issueId)
      if (!cur || vecScore > cur.vec) {
        const lex = Math.max(
          jaccard(qBi, bigrams(r.title)),
          jaccard(qBi, bigrams(r.title + r.title + r.content)),
        )
        best.set(r.issueId, {
          issueId: r.issueId,
          title: r.title,
          score: 0.65 * vecScore + 0.35 * lex,
          vec: vecScore,
          snippet: r.content.slice(0, 150),
        })
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /** 录入联动：与待录入文本最相似的既有隐患（仅案例库，按隐患去重取最高分段）
   *  纯向量对小库区分度不足（22 条隐患向量分挤在 0.05 区间内），
   *  混合检索：0.65×向量余弦 + 0.35×标题/内容字符二元组 Jaccard，专名命中才能排到前面 */
  async similarIssues(text: string, limit = 3) {
    const query = (text ?? '').trim()
    if (!query) return { ready: this.embedding.ready, items: [] }
    if (!this.embedding.ready) return { ready: false, items: [] }
    const [vec] = await this.embedding.embed([query], true)
    const rows = await this.issueCandidates(vec)
    const items = this.hybridRank(query, vec, rows, limit)
    return { ready: true, items }
  }

  /** 导入暂存区批量查重：一次嵌入多条草稿文本，逐条向量近邻 + 混合打分 */
  async similarBatch(texts: string[], limit = 2) {
    const queries = (texts ?? []).map((t) => (t ?? '').trim()).slice(0, 50)
    if (queries.length === 0) return { ready: this.embedding.ready, results: [] }
    if (!this.embedding.ready) return { ready: false, results: queries.map(() => []) }
    const vecs = await this.embedding.embed(queries, true)
    const results = [] as { issueId: string; title: string; score: number; vec: number; snippet: string }[][]
    for (let i = 0; i < queries.length; i++) {
      if (!queries[i]) {
        results.push([])
        continue
      }
      const rows = await this.issueCandidates(vecs[i])
      results.push(this.hybridRank(queries[i], vecs[i], rows, limit))
    }
    return { ready: true, results }
  }
}

@Controller('knowledge')
export class KnowledgeController {
  constructor(
    private readonly svc: KnowledgeService,
    private readonly llm: LlmService,
  ) {}

  @Get('status')
  status() {
    return this.svc.status()
  }

  /** 启动后台重建，立即返回；前端轮询 reindex/status */
  @Post('reindex')
  @Roles('admin')
  reindex() {
    return this.svc.startReindex()
  }

  @Get('reindex/status')
  reindexStatus() {
    return this.svc.reindexStatus()
  }

  /** 查看 LLM 配置（apiKey 脱敏，只回是否已配置） */
  @Get('config')
  async getConfig() {
    const cfg = await this.llm.getConfig()
    return { baseUrl: cfg.baseUrl, model: cfg.model, apiKeySet: !!cfg.apiKey }
  }

  /** 保存 LLM 配置（管理员；apiKey 留空表示不改动，clearApiKey 清除已存 Key） */
  @Put('config')
  @Roles('admin')
  async saveConfig(@Body() body: { apiKey?: string; baseUrl?: string; model?: string; clearApiKey?: boolean }) {
    await this.llm.saveConfig(body ?? {})
    const cfg = await this.llm.getConfig()
    return { baseUrl: cfg.baseUrl, model: cfg.model, apiKeySet: !!cfg.apiKey }
  }

  @Get('search')
  search(@Query('q') q: string, @Query('limit') limit?: string) {
    return this.svc.search(q ?? '', limit ? Number(limit) : 8)
  }

  /** 录入联动：与待录入问题最相似的既有隐患（登录即可用，结果按隐患去重） */
  @Post('similar')
  similar(@Body() body: { text?: string; limit?: number }) {
    return this.svc.similarIssues(body?.text ?? '', body?.limit ? Number(body.limit) : 3)
  }

  /** 导入暂存区批量查重：一次提交多条草稿文本，逐条返回相似既有隐患 */
  @Post('similar-batch')
  similarBatch(@Body() body: { texts?: string[]; limit?: number }) {
    return this.svc.similarBatch(body?.texts ?? [], body?.limit ? Number(body.limit) : 2)
  }

  /** AI 问答：先检索，配上 LLM 则生成回答；未配置 Key 时只返回检索结果（优雅降级） */
  @Post('ask')
  async ask(@Body() body: { question?: string }) {
    const question = (body?.question ?? '').trim()
    if (!question) throw new BadRequestException('请输入问题')
    const hits = await this.svc.search(question, 5)
    const answer = hits.length > 0 ? await this.llm.answer(question, hits) : null
    return { answer, hits, llmConfigured: await this.llm.isConfigured(), model: (await this.llm.getConfig()).model }
  }
}

@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, EmbeddingService, LlmService, PrismaService],
})
export class KnowledgeModule {}
