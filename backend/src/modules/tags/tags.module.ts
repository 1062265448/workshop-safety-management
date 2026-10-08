import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { Injectable, NotFoundException } from '@nestjs/common'
import { Module } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma.service'

const WRITABLE = ['name', 'group', 'color'] as const

function pick(body: Record<string, unknown>): Prisma.TagUncheckedCreateInput {
  const data: Record<string, unknown> = {}
  for (const key of WRITABLE) if (body[key] !== undefined) data[key] = body[key]
  return data as Prisma.TagUncheckedCreateInput
}

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(group?: string) {
    return this.prisma.tag.findMany({
      where: group ? { group } : undefined,
      orderBy: [{ group: 'asc' }, { name: 'asc' }],
    })
  }

  create(body: Record<string, unknown>) {
    return this.prisma.tag.create({ data: pick(body) })
  }

  /** 幂等建档：按 名称+维度组 查找，不存在则创建（导入解析自动建档用） */
  async ensure(body: { name?: string; group?: string }) {
    const name = body.name?.trim()
    const group = body.group?.trim()
    if (!name || !group) throw new NotFoundException('name 与 group 必填')
    const palette = ['#007AFF', '#FF9500', '#FF3B30', '#AF52DE', '#34C759', '#5856D6', '#5AC8FA', '#FFCC00']
    // upsert 原子操作，避免并发导入同一车间时重复创建冲突
    return this.prisma.tag.upsert({
      where: { name_group: { name, group } },
      create: { name, group, color: palette[name.length % palette.length], builtin: false },
      update: {},
    })
  }

  update(id: string, body: Record<string, unknown>) {
    return this.prisma.tag.update({ where: { id }, data: pick(body) })
  }

  /** 内置标签不可删除；删除时清理问题上的引用 */
  async remove(id: string) {
    const tag = await this.prisma.tag.findUnique({ where: { id } })
    if (!tag) throw new NotFoundException(`Tag ${id} not found`)
    if (tag.builtin) throw new NotFoundException('内置标签不可删除')
    await this.prisma.$transaction([
      this.prisma.$executeRaw`UPDATE issues SET "tagIds" = array_remove("tagIds", ${id}) WHERE ${id} = ANY("tagIds")`,
      this.prisma.issue.updateMany({ where: { categoryId: id }, data: { categoryId: null } }),
      this.prisma.issue.updateMany({ where: { locationId: id }, data: { locationId: null } }),
      this.prisma.tag.delete({ where: { id } }),
    ])
    return { ok: true }
  }
}

@Controller('tags')
export class TagsController {
  constructor(private readonly svc: TagsService) {}

  @Get()
  findAll(@Query('group') group?: string) {
    return this.svc.findAll(group)
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.svc.create(body)
  }

  @Post('ensure')
  ensure(@Body() body: { name?: string; group?: string }) {
    return this.svc.ensure(body)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.svc.update(id, body)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id)
  }
}

@Module({
  controllers: [TagsController],
  providers: [TagsService, PrismaService],
})
export class TagsModule {}
