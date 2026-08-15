import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/current-user.decorator';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto, UpdateConversationDto } from './conversation.dto';
import { MessagesService } from '../messages/messages.service';
import { CreateMessageDto } from '../messages/message.dto';
import { MessageRole } from '../messages/message.entity';

@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly messagesService: MessagesService,
  ) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateConversationDto) {
    return this.conversationsService.create(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.conversationsService.listForUser(user.userId);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.conversationsService.findOneForUser(id, user.userId);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.conversationsService.update(id, user.userId, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.conversationsService.remove(id, user.userId);
  }

  // ---- Mensagens da conversa ----

  @Get(':id/messages')
  listMessages(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.messagesService.listForConversation(id, user.userId);
  }

  // Por enquanto só grava a mensagem do usuário (sem chamar a IA ainda —
  // isso entra no próximo passo, com a fila BullMQ + orquestrador Ollama).
  @Post(':id/messages')
  addMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.messagesService.addMessage(id, user.userId, MessageRole.USER, dto.content);
  }
}
