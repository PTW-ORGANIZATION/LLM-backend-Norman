import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { QueueModule } from '../queue/queue.module';
import { InternalDocumentsController } from './internal-documents.controller';

@Module({
  imports: [DocumentsModule, QueueModule],
  controllers: [InternalDocumentsController],
})
export class IngestionModule {}
