import { Module } from '@nestjs/common'
import { PrismaService } from '../../prisma.service'
import { IssuesController } from './issues.controller'
import { IssuesService } from './issues.service'

@Module({
  controllers: [IssuesController],
  providers: [IssuesService, PrismaService],
})
export class IssuesModule {}
