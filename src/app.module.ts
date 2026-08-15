import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ConversationsModule } from './conversations/conversations.module';
import { MessagesModule } from './messages/messages.module';
import { OllamaModule } from './ollama/ollama.module';
import { DocumentsModule } from './documents/documents.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    DatabaseModule,
    UsersModule,
    AuthModule,
    ConversationsModule,
    MessagesModule,
    OllamaModule,
    DocumentsModule,
    OrchestratorModule,
  ],
})
export class AppModule {}
