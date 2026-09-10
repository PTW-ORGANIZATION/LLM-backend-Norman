import { Module } from '@nestjs/common';
import { RetentionScheduler } from '../config/retention.scheduler';
import { RetentionService } from '../config/retention.service';
import { QueueModule } from '../queue/queue.module';
import { HealthController } from './health.controller';

@Module({
  imports: [QueueModule],
  controllers: [HealthController],
  providers: [RetentionService, RetentionScheduler],
  exports: [RetentionService],
})
export class HealthModule {}
