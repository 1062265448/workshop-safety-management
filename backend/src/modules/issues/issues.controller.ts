import { Body, Controller, Delete, Get, GoneException, Param, Patch, Post, Query, Request } from '@nestjs/common'
import { IssuesService } from './issues.service'

type Req = { user?: { sub?: string }; headers?: Record<string, unknown> }
const context = (req: Req) => ({
  actor: req.user?.sub || 'system',
  requestId: typeof req.headers?.['x-request-id'] === 'string' ? req.headers['x-request-id'] as string : null,
})

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
  knowledgeDocs() { return this.svc.knowledgeDocs() }

  @Get(':id')
  findOne(@Param('id') id: string) { return this.svc.findOne(id) }

  @Post()
  create(@Body() body: Record<string, unknown>, @Request() req: Req) { return this.svc.create(body, context(req)) }

  @Post('batch')
  createBatch() { throw new GoneException('旧批量接口已停用，请使用 /api/imports/batches 并提供 idempotencyKey') }

  @Post(':id/status')
  updateStatus(@Param('id') id: string, @Body() body: { status?: string }, @Request() req: Req) {
    return this.svc.updateStatus(id, body?.status, context(req))
  }

  @Post(':id/close')
  close(@Param('id') id: string, @Body() body: { fixNote?: string; photos?: string[]; closedAt?: string }, @Request() req: Req) {
    return this.svc.close(id, body ?? {}, context(req))
  }

  @Post(':id/evidence-corrections')
  correctEvidence(
    @Param('id') id: string,
    @Body() body: { fixNote?: string; photos?: string[]; reason?: string },
    @Request() req: Req,
  ) {
    return this.svc.correctEvidence(id, body ?? {}, context(req))
  }

  @Post(':id/reviewed')
  markReviewed(@Param('id') id: string, @Request() req: Req) { return this.svc.markReviewed(id, context(req)) }

  @Post(':id/recheck')
  recheck(
    @Param('id') id: string,
    @Body() body: { failed?: boolean; note?: string; photos?: string[]; checkedAt?: string },
    @Request() req: Req,
  ) {
    return this.svc.recheck(id, body ?? {}, context(req))
  }

  @Post(':id/stage/next')
  advanceStage(
    @Param('id') id: string,
    @Body() body: { note?: string; linkedKnowledgeDocId?: string },
    @Request() req: Req,
  ) {
    return this.svc.advanceStage(id, body ?? {}, context(req))
  }

  @Post(':id/restore')
  restore(@Param('id') id: string, @Request() req: Req) { return this.svc.restore(id, context(req)) }

  @Post(':id/regulations')
  linkRegulation(@Param('id') id: string, @Body() body: { regulationId?: string }, @Request() req: Req) {
    return this.svc.linkRegulation(id, body?.regulationId, context(req))
  }

  @Delete(':id/regulations/:rid')
  unlinkRegulation(@Param('id') id: string, @Param('rid') rid: string, @Request() req: Req) {
    return this.svc.unlinkRegulation(id, rid, context(req))
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Request() req: Req) {
    return this.svc.update(id, body, context(req))
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: Req) { return this.svc.remove(id, context(req)) }

  @Delete(':id/hard')
  hardRemove(@Param('id') id: string, @Request() req: Req) { return this.svc.hardRemove(id, context(req)) }
}
