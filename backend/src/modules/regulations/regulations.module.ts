import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Post, Put, Query } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma.service'
import { Roles } from '../auth/auth.module'

// ─────────────────────────────────────────────────────────────
// 法规制度库：5 类分类（国家法律/行政法规/国家标准/集团制度/厂级制度）
// 隐患通过 IssueRegulation 多对多关联法规依据；库的维护仅管理员
// ─────────────────────────────────────────────────────────────

export const REGULATION_CATEGORIES = ['national_law', 'regulation', 'gb_standard', 'group_policy', 'factory_policy'] as const

@Injectable()
export class RegulationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 法规列表：?q= 关键词（标题/条款号/摘要）+ ?category= 分类筛选 */
  findAll(filters: { q?: string; category?: string }) {
    const where: Prisma.RegulationWhereInput = {}
    if (filters.category) where.category = filters.category
    if (filters.q?.trim()) {
      const q = filters.q.trim()
      where.OR = [
        { title: { contains: q } },
        { articleNo: { contains: q } },
        { summary: { contains: q } },
      ]
    }
    return this.prisma.regulation.findMany({ where, orderBy: [{ category: 'asc' }, { createdAt: 'asc' }] })
  }

  async create(body: { category?: string; title?: string; articleNo?: string; summary?: string }) {
    const title = body.title?.trim()
    if (!title) throw new BadRequestException('标题不能为空')
    if (!body.category || !REGULATION_CATEGORIES.includes(body.category as (typeof REGULATION_CATEGORIES)[number])) {
      throw new BadRequestException('分类无效，须为：' + REGULATION_CATEGORIES.join(' / '))
    }
    return this.prisma.regulation.create({
      data: { category: body.category, title, articleNo: body.articleNo?.trim() || null, summary: body.summary?.trim() ?? '' },
    })
  }

  async update(id: string, body: { category?: string; title?: string; articleNo?: string | null; summary?: string }) {
    const existing = await this.prisma.regulation.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException(`Regulation ${id} not found`)
    const data: Prisma.RegulationUncheckedUpdateInput = {}
    if (body.category !== undefined) {
      if (!REGULATION_CATEGORIES.includes(body.category as (typeof REGULATION_CATEGORIES)[number])) {
        throw new BadRequestException('分类无效，须为：' + REGULATION_CATEGORIES.join(' / '))
      }
      data.category = body.category
    }
    if (body.title !== undefined) {
      if (!body.title.trim()) throw new BadRequestException('标题不能为空')
      data.title = body.title.trim()
    }
    if (body.articleNo !== undefined) data.articleNo = body.articleNo?.trim() || null
    if (body.summary !== undefined) data.summary = body.summary.trim()
    return this.prisma.regulation.update({ where: { id }, data })
  }

  async remove(id: string) {
    const existing = await this.prisma.regulation.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException(`Regulation ${id} not found`)
    // 关联记录由外键级联删除
    return this.prisma.regulation.delete({ where: { id } })
  }
}

@Controller('regulations')
export class RegulationsController {
  constructor(private readonly svc: RegulationsService) {}

  @Get()
  findAll(@Query('q') q?: string, @Query('category') category?: string) {
    return this.svc.findAll({ q, category })
  }

  @Post()
  @Roles('admin')
  create(@Body() body: { category?: string; title?: string; articleNo?: string; summary?: string }) {
    return this.svc.create(body ?? {})
  }

  @Put(':id')
  @Roles('admin')
  update(@Param('id') id: string, @Body() body: { category?: string; title?: string; articleNo?: string | null; summary?: string }) {
    return this.svc.update(id, body ?? {})
  }

  @Delete(':id')
  @Roles('admin')
  remove(@Param('id') id: string) {
    return this.svc.remove(id)
  }
}

@Module({
  controllers: [RegulationsController],
  providers: [RegulationsService, PrismaService],
})
export class RegulationsModule {}
