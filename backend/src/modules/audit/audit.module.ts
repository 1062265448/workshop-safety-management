import { Injectable, Module } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma.service'

export interface AuditInput {
  issueId?: string | null
  actor: string
  action: string
  from?: unknown
  to?: unknown
  detail?: unknown
  requestId?: string | null
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(tx: Prisma.TransactionClient, input: AuditInput) {
    return tx.auditLog.create({
      data: {
        issueId: input.issueId || null,
        actor: input.actor || 'system',
        action: input.action,
        from: input.from === undefined ? Prisma.JsonNull : input.from as Prisma.InputJsonValue,
        to: input.to === undefined ? Prisma.JsonNull : input.to as Prisma.InputJsonValue,
        detail: input.detail === undefined ? Prisma.JsonNull : input.detail as Prisma.InputJsonValue,
        requestId: input.requestId || null,
      },
    })
  }
}

@Module({
  providers: [AuditService, PrismaService],
  exports: [AuditService],
})
export class AuditModule {}
