import { OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { AI_JOBS_QUEUE_NAME } from '../queue/queue.constants';
import { AiJob, AiJobStatus } from './ai-job.entity';
import { AiJobData } from './ai-job-data.interface';
import { ConversationsService } from '../conversations/conversations.service';
import { MessagesService } from '../messages/messages.service';
import { MessageRole } from '../messages/message.entity';
import { OllamaService, OllamaChatMessage } from '../ollama/ollama.service';
import { DocumentChunksService } from '../documents/document-chunks.service';

const BASE_SYSTEM_PROMPT =
  'Você é um assistente útil e direto. Responda em português do Brasil, de forma clara e objetiva.';

@Processor(AI_JOBS_QUEUE_NAME)
export class AiJobProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly conversationsService: ConversationsService,
    private readonly messagesService: MessagesService,
    private readonly ollamaService: OllamaService,
    private readonly documentChunksService: DocumentChunksService,
    @InjectRepository(AiJob)
    private readonly aiJobsRepository: Repository<AiJob>,
  ) {
    super();
  }

  // O decorator @Processor roda antes do container de DI existir, então não dá
  // pra injetar ConfigService nele — a concorrência é ajustada aqui em vez disso.
  onModuleInit() {
    this.worker.concurrency = this.config.get<number>('queue.concurrency', 2);
  }

  async process(job: Job<AiJobData>) {
    const { conversationId, userId, organizationId } = job.data;
    const startedAt = Date.now();

    const aiJob = await this.aiJobsRepository.save(
      this.aiJobsRepository.create({
        userId,
        conversationId,
        status: AiJobStatus.PROCESSING,
      }),
    );

    try {
      const conversation = await this.conversationsService.findOneForUser(conversationId, userId);
      const recentMessages = await this.messagesService.getRecentForConversation(conversationId);
      const lastMessage = recentMessages[recentMessages.length - 1];

      let chunks: Array<{ content: string }> = [];
      if (organizationId && lastMessage) {
        const embedding = await this.ollamaService.embed(lastMessage.content);
        chunks = await this.documentChunksService.searchSimilar({
          userId,
          organizationId,
          projectId: conversation.projectId,
          embedding,
        });
      }

      let systemContent = BASE_SYSTEM_PROMPT;
      if (chunks.length > 0) {
        systemContent +=
          '\n\nContexto relevante extraído da base de conhecimento:\n' +
          chunks.map((c) => `- ${c.content}`).join('\n');
      }

      const promptMessages: OllamaChatMessage[] = [
        { role: 'system', content: systemContent },
        ...recentMessages.map((m) => ({
          role: m.role as OllamaChatMessage['role'],
          content: m.content,
        })),
      ];

      const timeoutMs = this.config.get<number>('queue.jobTimeoutMs', 300000);
      let fullResponse = '';
      for await (const tokenChunk of this.ollamaService.chatStream(promptMessages, { timeoutMs })) {
        fullResponse += tokenChunk;
        await job.updateProgress({ token: tokenChunk });
      }

      const savedMessage = await this.messagesService.addMessage(
        conversationId,
        userId,
        MessageRole.ASSISTANT,
        fullResponse,
      );

      await this.aiJobsRepository.update(aiJob.id, {
        status: AiJobStatus.COMPLETED,
        finishedAt: new Date(),
        latencyMs: Date.now() - startedAt,
      });

      return savedMessage;
    } catch (error) {
      await this.aiJobsRepository.update(aiJob.id, {
        status: AiJobStatus.FAILED,
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      });
      throw error;
    }
  }
}
