import { Body, Controller, Delete, Get, Module, NotFoundException, Param, Put } from '@nestjs/common'
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma.service'
import { KnowledgeModule, KnowledgeService } from '../knowledge/knowledge.module'

// ─────────────────────────────────────────────────────────────
// 参考件问题标注：评估其他车间问题对成品车间的参考意义
// 一隐患一条标注（issueId 唯一），PUT upsert 幂等
// ─────────────────────────────────────────────────────────────

const RELEVANCE = new Set(['high', 'medium', 'low'])

@Injectable()
export class AnnotationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
  ) {}

  findAll() {
    return this.prisma.issueAnnotation.findMany({ orderBy: { updatedAt: 'desc' } })
  }

  async upsert(issueId: string, body: { relevance?: string; similarity?: string; caution?: string; tagId?: string | null }) {
    const issue = await this.prisma.issue.findUnique({ where: { id: issueId } })
    if (!issue) throw new NotFoundException(`Issue ${issueId} not found`)
    // 隐患类型标签：传 null/空串清除；传值则必须存在于 tags 表
    let tagId: string | null = null
    if (body.tagId) {
      const tag = await this.prisma.tag.findUnique({ where: { id: body.tagId } })
      if (!tag) throw new NotFoundException(`Tag ${body.tagId} not found`)
      tagId = tag.id
    }
    const data = {
      relevance: RELEVANCE.has(body.relevance ?? '') ? body.relevance! : 'medium',
      similarity: (body.similarity ?? '').trim(),
      caution: (body.caution ?? '').trim(),
      tagId,
    }
    const saved = await this.prisma.issueAnnotation.upsert({
      where: { issueId },
      create: { issueId, ...data },
      update: data,
    })
    void this.knowledge.syncIssues([issueId]) // 参考意义写进知识库文档
    return saved
  }

  async remove(issueId: string) {
    const removed = await this.prisma.issueAnnotation.deleteMany({ where: { issueId } })
    void this.knowledge.syncIssues([issueId]) // 标注删除同步移除文档中的参考意义段
    return removed
  }
}

@Controller('annotations')
export class AnnotationsController {
  constructor(private readonly svc: AnnotationsService) {}

  @Get()
  findAll() {
    return this.svc.findAll()
  }

  @Put(':issueId')
  upsert(@Param('issueId') issueId: string, @Body() body: { relevance?: string; similarity?: string; caution?: string; tagId?: string | null }) {
    return this.svc.upsert(issueId, body ?? {})
  }

  @Delete(':issueId')
  remove(@Param('issueId') issueId: string) {
    return this.svc.remove(issueId)
  }
}

@Module({
  imports: [KnowledgeModule],
  controllers: [AnnotationsController],
  providers: [AnnotationsService, PrismaService],
})
export class AnnotationsModule {}
