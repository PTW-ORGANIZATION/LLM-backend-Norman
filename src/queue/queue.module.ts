import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QueueEvents } from 'bullmq';
import {
  AI_JOBS_QUEUE_EVENTS,
  AI_JOBS_QUEUE_NAME,
  INGESTION_JOBS_QUEUE_NAME,
  KNOWLEDGE_JOBS_QUEUE_NAME,
} from './queue.constants';
import { JobStreamService } from './job-stream.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host'),
          port: config.get<number>('redis.port'),
          password: config.get<string>('redis.password'),
        },
      }),
    }),
    BullModule.registerQueue({ name: AI_JOBS_QUEUE_NAME }),
    BullModule.registerQueue({ name: INGESTION_JOBS_QUEUE_NAME }),
    BullModule.registerQueue({ name: KNOWLEDGE_JOBS_QUEUE_NAME }),
  ],
  providers: [
    {
      provide: AI_JOBS_QUEUE_EVENTS,
      inject: [ConfigService],
      // Instância ÚNICA e compartilhada — evita abrir uma conexão Redis nova
      // por cliente SSE conectado.
      useFactory: (config: ConfigService) =>
        new QueueEvents(AI_JOBS_QUEUE_NAME, {
          connection: {
            host: config.get<string>('redis.host'),
            port: config.get<number>('redis.port'),
            password: config.get<string>('redis.password'),
          },
        }),
    },
    JobStreamService,
  ],
  exports: [BullModule, JobStreamService],
})
export class QueueModule implements OnModuleDestroy {
  constructor(@Inject(AI_JOBS_QUEUE_EVENTS) private readonly queueEvents: QueueEvents) {}

  async onModuleDestroy() {
    await this.queueEvents.close();
  }
}
