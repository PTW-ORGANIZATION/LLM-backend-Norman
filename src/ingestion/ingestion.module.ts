import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { OllamaModule } from '../ollama/ollama.module';
import { QueueModule } from '../queue/queue.module';
import { InternalDocumentsController } from './internal-documents.controller';
import { InternalKnowledgeController } from './internal-knowledge.controller';
import { IngestionProcessor } from './ingestion.processor';
import { TextExtractionService } from './extraction/text-extraction.service';
import { DocumentContentPort } from './document-content.port';
import { NormanDocumentContentAdapter } from './norman-document-content.adapter';

@Module({
  imports: [DocumentsModule, OllamaModule, QueueModule],
  controllers: [InternalDocumentsController, InternalKnowledgeController],
  providers: [
    TextExtractionService,
    IngestionProcessor,
    { provide: DocumentContentPort, useClass: NormanDocumentContentAdapter },
  ],
})
export class IngestionModule {}
