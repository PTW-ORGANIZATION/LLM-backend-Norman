import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from './conversation.entity';
import { CreateConversationDto, UpdateConversationDto } from './conversation.dto';

@Injectable()
export class ConversationsService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversationsRepository: Repository<Conversation>,
  ) {}

  async create(userId: string, dto: CreateConversationDto): Promise<Conversation> {
    const conversation = this.conversationsRepository.create({
      userId,
      title: dto.title ?? null,
      projectId: dto.projectId ?? null,
    });
    return this.conversationsRepository.save(conversation);
  }

  // Regra crítica de isolamento (seção 4.2 do documento): sempre filtrar por userId.
  async listForUser(userId: string): Promise<Conversation[]> {
    return this.conversationsRepository.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  async findOneForUser(id: string, userId: string): Promise<Conversation> {
    const conversation = await this.conversationsRepository.findOne({
      where: { id, userId },
    });
    if (!conversation) {
      throw new NotFoundException('Conversa não encontrada.');
    }
    return conversation;
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateConversationDto,
  ): Promise<Conversation> {
    const conversation = await this.findOneForUser(id, userId);
    if (dto.title !== undefined) {
      conversation.title = dto.title;
    }
    return this.conversationsRepository.save(conversation);
  }

  async remove(id: string, userId: string): Promise<void> {
    const conversation = await this.findOneForUser(id, userId);
    await this.conversationsRepository.remove(conversation);
  }

  async touchUpdatedAt(id: string): Promise<void> {
    await this.conversationsRepository.update(id, { updatedAt: new Date() });
  }
}
