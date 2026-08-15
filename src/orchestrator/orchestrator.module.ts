import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiJob } from './ai-job.entity';
import { AiJobProcessor } from './ai-job.processor';
import { QueueModule } from '../queue/queue.module';
import { OllamaModule } from '../ollama/ollama.module';
import { DocumentsModule } from '../documents/documents.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessagesModule } from '../messages/messages.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AiJob]),
    QueueModule,
    OllamaModule,
    DocumentsModule,
    ConversationsModule,
    MessagesModule,
  ],
  providers: [AiJobProcessor],
})
export class OrchestratorModule {}
