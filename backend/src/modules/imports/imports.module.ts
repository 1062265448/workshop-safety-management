import { Module } from '@nestjs/common'
import { PrismaService } from '../../prisma.service'
import { OutboxModule } from '../outbox/outbox.module'
import { AuditModule } from '../audit/audit.module'
import { ImportsController } from './imports.controller'
import { ImportService } from './imports.service'

export * from './imports.service'

@Module({
  imports: [OutboxModule, AuditModule],
  controllers: [ImportsController],
  providers: [ImportService, PrismaService],
  exports: [ImportService],
})
export class ImportsModule {}
