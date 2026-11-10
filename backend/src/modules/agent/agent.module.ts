import { Module } from '@nestjs/common'
import { PrismaService } from '../../prisma.service'
import { LlmService } from '../knowledge/llm.service'
import { AgentController } from './agent.controller'
import { AgentService } from './agent.service'
import { AgentTools } from './agent.tools'
import { MetricsModule } from '../metrics/metrics.module'

@Module({
  imports: [MetricsModule],
  controllers: [AgentController],
  providers: [AgentService, AgentTools, LlmService, PrismaService],
})
export class AgentModule {}
