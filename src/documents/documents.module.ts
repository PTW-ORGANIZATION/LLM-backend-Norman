import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentChunk } from './document-chunk.entity';
import { DocumentChunksService } from './document-chunks.service';

@Module({
  imports: [TypeOrmModule.forFeature([DocumentChunk])],
  providers: [DocumentChunksService],
  exports: [DocumentChunksService],
})
export class DocumentsModule {}
