import { Body, Controller, Get, Param, Post, Query, Request } from '@nestjs/common'
import { Roles } from '../auth/auth.module'
import { AgentService } from './agent.service'

@Controller('agent')
@Roles('admin', 'safety_officer', 'viewer')
export class AgentController {
  constructor(private readonly svc: AgentService) {}

  @Get('capabilities')
  @Roles('admin')
  capabilities() {
    return this.svc.capabilities()
  }

  /** 创建后异步执行有界只读任务；POST 仅创建 Agent 自身轨迹，不修改业务表。 */
  @Post('runs')
  run(@Body() body: { question?: unknown }, @Request() req: { user: { sub: string } }) {
    return this.svc.run(body?.question, req.user.sub)
  }

  @Get('runs')
  listRuns(@Query('page') page: string | undefined, @Query('pageSize') pageSize: string | undefined, @Request() req: { user: { sub: string } }) {
    return this.svc.listRuns(req.user.sub, page ?? 1, pageSize ?? 10)
  }

  @Get('runs/:id')
  getRun(@Param('id') id: string, @Request() req: { user: { sub: string } }) {
    return this.svc.getRun(id, req.user.sub)
  }

  @Post('runs/:id/cancel')
  cancel(@Param('id') id: string, @Request() req: { user: { sub: string } }) {
    return this.svc.cancel(id, req.user.sub)
  }
}
