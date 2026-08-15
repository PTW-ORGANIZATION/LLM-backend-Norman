import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message, MessageRole } from './message.entity';
import { ConversationsService } from '../conversations/conversations.service';

const RECENT_MESSAGES_LIMIT = 20; // "Histórico Recente" citado na seção 4.2 do documento

@Injectable()
export class MessagesService {
  constructor(
    @InjectRepository(Message)
    private readonly messagesRepository: Repository<Message>,
    private readonly conversationsService: ConversationsService,
  ) {}

  // Confere que a conversa pertence ao usuário antes de listar/gravar mensagens.
  async listForConversation(conversationId: string, userId: string): Promise<Message[]> {
    await this.conversationsService.findOneForUser(conversationId, userId);
    return this.messagesRepository.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
    });
  }

  async getRecentForConversation(conversationId: string): Promise<Message[]> {
    const messages = await this.messagesRepository.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: RECENT_MESSAGES_LIMIT,
    });
    return messages.reverse(); // devolve em ordem cronológica
  }

  async addMessage(
    conversationId: string,
    userId: string,
    role: MessageRole,
    content: string,
  ): Promise<Message> {
    await this.conversationsService.findOneForUser(conversationId, userId);

    const message = this.messagesRepository.create({
      conversationId,
      role,
      content,
    });
    const saved = await this.messagesRepository.save(message);
    await this.conversationsService.touchUpdatedAt(conversationId);
    return saved;
  }
}
