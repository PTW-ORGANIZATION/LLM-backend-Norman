import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentChunk } from './document-chunk.entity';
import { DocumentRecord } from './document.entity';
import { KnowledgeRevocation } from './knowledge-revocation.entity';
import { DocumentChunksService } from './document-chunks.service';
import { DocumentsService } from './documents.service';
import { RevocationsService } from './revocations.service';

@Module({
  imports: [TypeOrmModule.forFeature([DocumentChunk, DocumentRecord, KnowledgeRevocation])],
  providers: [DocumentChunksService, DocumentsService, RevocationsService],
  exports: [DocumentChunksService, DocumentsService, RevocationsService],
})
export class DocumentsModule {}
