import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { IssuesService } from './issues.service'

@Controller('issues')
export class IssuesController {
  constructor(private readonly svc: IssuesService) {}

  @Get()
  findAll(
    @Query('status') status?: string,
    @Query('categoryId') categoryId?: string,
    @Query('locationId') locationId?: string,
    @Query('q') q?: string,
    @Query('bin') bin?: string,
  ) {
    return this.svc.findAll({ status, categoryId, locationId, q, bin: bin === '1' })
  }

  @Get('knowledge-docs')
  knowledgeDocs() {
    return this.svc.knowledgeDocs()
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id)
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.svc.create(body)
  }

  @Post('batch')
  createBatch(@Body() body: { items: Record<string, unknown>[] }) {
    return this.svc.createBatch(body.items ?? [])
  }

  @Post(':id/recheck')
  recheck(@Param('id') id: string, @Body() body?: { failed?: boolean }) {
    return this.svc.recheck(id, body?.failed === true)
  }

  /** 整改闭环阶段推进：完成当前阶段（制度沉淀阶段可带制度要点与知识库条目） */
  @Post(':id/stage/next')
  advanceStage(@Param('id') id: string, @Body() body?: { note?: string; linkedKnowledgeDocId?: string }) {
    return this.svc.advanceStage(id, body ?? {})
  }

  /** 回收站恢复 */
  @Post(':id/restore')
  restore(@Param('id') id: string) {
    return this.svc.restore(id)
  }

  /** 关联法规依据（幂等） */
  @Post(':id/regulations')
  linkRegulation(@Param('id') id: string, @Body() body: { regulationId?: string }) {
    return this.svc.linkRegulation(id, body?.regulationId)
  }

  /** 取消法规依据关联 */
  @Delete(':id/regulations/:rid')
  unlinkRegulation(@Param('id') id: string, @Param('rid') rid: string) {
    return this.svc.unlinkRegulation(id, rid)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.svc.update(id, body)
  }

  /** 软删除：进回收站，可恢复 */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id)
  }

  /** 彻底删除：仅回收站中的条目，不可恢复 */
  @Delete(':id/hard')
  hardRemove(@Param('id') id: string) {
    return this.svc.hardRemove(id)
  }
}
