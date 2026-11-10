import { Body, Controller, Post, Request } from '@nestjs/common'
import { CreateImportBatchInput, ImportService } from './imports.service'

type Req = { user?: { sub?: string }; headers?: Record<string, unknown> }

@Controller('imports')
export class ImportsController {
  constructor(private readonly svc: ImportService) {}

  @Post('batches')
  createBatch(@Body() body: CreateImportBatchInput, @Request() req: Req) {
    return this.svc.createBatch(body, {
      actor: req.user?.sub || 'system',
      requestId: typeof req.headers?.['x-request-id'] === 'string' ? req.headers['x-request-id'] as string : null,
    })
  }
}
