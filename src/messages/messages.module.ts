import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from './message.entity';
import { MessagesService } from './messages.service';
import { ConversationsModule } from '../conversations/conversations.module';

@Module({
  imports: [TypeOrmModule.forFeature([Message]), forwardRef(() => ConversationsModule)],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
