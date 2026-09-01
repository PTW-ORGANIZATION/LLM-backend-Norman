import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentChunk } from './document-chunk.entity';
import { DocumentRecord } from './document.entity';
import { DocumentChunksService } from './document-chunks.service';
import { DocumentsService } from './documents.service';

@Module({
  imports: [TypeOrmModule.forFeature([DocumentChunk, DocumentRecord])],
  providers: [DocumentChunksService, DocumentsService],
  exports: [DocumentChunksService, DocumentsService],
})
export class DocumentsModule {}
