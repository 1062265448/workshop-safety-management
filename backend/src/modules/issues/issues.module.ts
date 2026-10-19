import { Module } from '@nestjs/common'
import { PrismaService } from '../../prisma.service'
import { KnowledgeModule } from '../knowledge/knowledge.module'
import { AssessmentsModule } from '../assessments/assessments.module'
import { IssuesController } from './issues.controller'
import { IssuesService } from './issues.service'

@Module({
  imports: [KnowledgeModule, AssessmentsModule],
  controllers: [IssuesController],
  providers: [IssuesService, PrismaService],
})
export class IssuesModule {}
