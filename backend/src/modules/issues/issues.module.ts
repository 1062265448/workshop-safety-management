import { Module } from '@nestjs/common'
import { PrismaService } from '../../prisma.service'
import { OutboxModule } from '../outbox/outbox.module'
import { AuditModule } from '../audit/audit.module'
import { IssuesController } from './issues.controller'
import { IssuesService } from './issues.service'
export { IssuesService } from './issues.service'

@Module({
  imports: [OutboxModule, AuditModule],
  controllers: [IssuesController],
  providers: [IssuesService, PrismaService],
  exports: [IssuesService],
})
export class IssuesModule {}
