import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/current-user.decorator';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto, UpdateConversationDto } from './conversation.dto';
import { MessagesService } from '../messages/messages.service';
import { CreateMessageDto } from '../messages/message.dto';
import { MessageRole } from '../messages/message.entity';
import { AI_JOBS_QUEUE_NAME } from '../queue/queue.constants';
import { JobStreamService } from '../queue/job-stream.service';
import { AiJobData } from '../orchestrator/ai-job-data.interface';

@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly messagesService: MessagesService,
    @InjectQueue(AI_JOBS_QUEUE_NAME) private readonly aiJobsQueue: Queue<AiJobData>,
    private readonly jobStreamService: JobStreamService,
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

  // Grava a mensagem do usuário e enfileira a geração da resposta da IA.
  // O cliente acompanha o resultado via GET :id/jobs/:jobId/stream (SSE).
  @Post(':id/messages')
  async addMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateMessageDto,
  ) {
    const message = await this.messagesService.addMessage(
      id,
      user.userId,
      MessageRole.USER,
      dto.content,
    );

    const job = await this.aiJobsQueue.add(
      'generate-response',
      { conversationId: id, userId: user.userId, organizationId: user.organizationId },
      { attempts: 2, backoff: { type: 'exponential', delay: 2000 } },
    );

    return { message, jobId: job.id };
  }

  // EventSource nativo do browser não manda header customizado — por isso o
  // token também é aceito via query string (ver jwt.strategy.ts).
  @Sse(':id/jobs/:jobId/stream')
  async streamJob(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ): Promise<Observable<MessageEvent>> {
    await this.conversationsService.findOneForUser(id, user.userId);
    return this.jobStreamService.stream(jobId);
  }
}
