// ─────────────────────────────────────────────────────────────
// 知识库模块：把存量业务数据（隐患/参考标注/督查通报）向量化入库，
// 提供语义检索 + AI 问答（LLM 预留，未配置 Key 时只返回检索结果）
// ─────────────────────────────────────────────────────────────
import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common'
import { Injectable, BadRequestException } from '@nestjs/common'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { PrismaService } from '../../prisma.service'
import { EmbeddingService } from './embedding.service'
import { LlmService, KnowledgeHit } from './llm.service'
import { Roles } from '../auth/auth.module'

const BULLETIN_DIR = resolve(process.env.BULLETIN_DIR || join(process.cwd(), '..', '厂督察通报'))

interface DocDraft {
  kind: string
  refId: string | null
  title: string
  source: string
  chunks: string[]
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

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
    private readonly llm: LlmService,
  ) {}

  async status() {
    const [docs, chunks] = await Promise.all([
      this.prisma.knowledgeDoc.count(),
      this.prisma.knowledgeChunk.count(),
    ])
    const byKind = await this.prisma.knowledgeDoc.groupBy({ by: ['kind'], _count: true })
    return {
      modelReady: this.embedding.ready,
      modelDir: this.embedding.modelDir,
      bulletinDir: BULLETIN_DIR,
      bulletinDirExists: existsSync(BULLETIN_DIR),
      llm: { configured: this.llm.configured, model: this.llm.model },
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
      this.prisma.issue.findMany({ orderBy: { foundAt: 'desc' } }),
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

  /** 全量重建索引（管理员操作；先清后建，保证与业务数据一致） */
  async reindex() {
    if (!this.embedding.ready) throw new BadRequestException(`嵌入模型文件缺失：${this.embedding.modelDir}`)
    const started = Date.now()
    const drafts = await this.collectDocs()
    await this.prisma.knowledgeDoc.deleteMany() // chunks 级联删除

    let chunkTotal = 0
    for (const draft of drafts) {
      const doc = await this.prisma.knowledgeDoc.create({
        data: { kind: draft.kind, refId: draft.refId, title: draft.title, source: draft.source },
      })
      const vectors = await this.embedding.embed(draft.chunks)
      for (let i = 0; i < draft.chunks.length; i++) {
        // vector 为 Unsupported 类型，用原生 SQL 写入
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO knowledge_chunks (id, "docId", seq, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)`,
          `kc_${doc.id}_${i}`,
          doc.id,
          i,
          draft.chunks[i],
          `[${vectors[i].join(',')}]`,
        )
        chunkTotal++
      }
    }
    return { docs: drafts.length, chunks: chunkTotal, tookMs: Date.now() - started }
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

  @Post('reindex')
  @Roles('admin')
  reindex() {
    return this.svc.reindex()
  }

  @Get('search')
  search(@Query('q') q: string, @Query('limit') limit?: string) {
    return this.svc.search(q ?? '', limit ? Number(limit) : 8)
  }

  /** AI 问答：先检索，配上 LLM 则生成回答；未配置 Key 时只返回检索结果（优雅降级） */
  @Post('ask')
  async ask(@Body() body: { question?: string }) {
    const question = (body?.question ?? '').trim()
    if (!question) throw new BadRequestException('请输入问题')
    const hits = await this.svc.search(question, 5)
    const answer = hits.length > 0 ? await this.llm.answer(question, hits) : null
    return { answer, hits, llmConfigured: this.llm.configured, model: this.llm.model }
  }
}

@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, EmbeddingService, LlmService, PrismaService],
})
export class KnowledgeModule {}
