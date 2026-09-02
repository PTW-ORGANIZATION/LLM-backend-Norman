import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentsModule } from '../documents/documents.module';
import { OllamaModule } from '../ollama/ollama.module';
import { QueueModule } from '../queue/queue.module';
import { KnowledgeNote } from './knowledge-note.entity';
import { KnowledgeNotesService } from './knowledge-notes.service';
import { KnowledgeProcessor } from './knowledge.processor';
import { NoteGenerationService } from './note-generation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([KnowledgeNote]),
    DocumentsModule,
    OllamaModule,
    QueueModule,
  ],
  providers: [KnowledgeNotesService, NoteGenerationService, KnowledgeProcessor],
  exports: [KnowledgeNotesService],
})
export class KnowledgeModule {}
