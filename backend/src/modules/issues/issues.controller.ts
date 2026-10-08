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
  ) {
    return this.svc.findAll({ status, categoryId, locationId, q })
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
  recheck(@Param('id') id: string) {
    return this.svc.recheck(id)
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
