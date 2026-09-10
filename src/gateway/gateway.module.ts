import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentsModule } from '../documents/documents.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { OllamaModule } from '../ollama/ollama.module';
import { ConnectionActivation } from './connection-activation.entity';
import { ConnectionRevision } from './connection-revision.entity';
import { ConnectionRevisionsService } from './connection-revisions.service';
import { GenerationExecution } from './generation-execution.entity';
import { ConnectionTestService } from './connection-test.service';
import { GenerationService } from './generation.service';
import { InternalGenerationController } from './internal-generation.controller';
import { OpenAiChatAdapter } from './openai-chat.adapter';
import { LLM_PROVIDER } from './llm-provider.token';

@Module({
  imports: [
    TypeOrmModule.forFeature([GenerationExecution, ConnectionRevision, ConnectionActivation]),
    DocumentsModule,
    KnowledgeModule,
    OllamaModule,
  ],
  controllers: [InternalGenerationController],
  providers: [
    OpenAiChatAdapter,
    { provide: LLM_PROVIDER, useExisting: OpenAiChatAdapter },
    ConnectionRevisionsService,
    GenerationService,
    ConnectionTestService,
  ],
  exports: [GenerationService, ConnectionTestService, ConnectionRevisionsService],
})
export class GatewayModule {}
