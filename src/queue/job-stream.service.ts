import { Inject, Injectable, MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { QueueEvents } from 'bullmq';
import { AI_JOBS_QUEUE_EVENTS } from './queue.constants';

@Injectable()
export class JobStreamService {
  constructor(@Inject(AI_JOBS_QUEUE_EVENTS) private readonly queueEvents: QueueEvents) {}

  // Ponte entre o worker (BullMQ) e o cliente HTTP (SSE), via os eventos da
  // fila. Se o cliente reconectar no meio de uma resposta, ele só recebe os
  // chunks a partir dali — o BullMQ só guarda o último progress, não o texto
  // acumulado. Limitação aceita para este MVP.
  stream(jobId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const onProgress = (event: { jobId: string; data: unknown }) => {
        if (event.jobId !== jobId) return;
        subscriber.next({ data: event.data as object });
      };

      const onCompleted = (event: { jobId: string }) => {
        if (event.jobId !== jobId) return;
        subscriber.next({ type: 'done', data: {} });
        subscriber.complete();
      };

      const onFailed = (event: { jobId: string; failedReason: string }) => {
        if (event.jobId !== jobId) return;
        subscriber.next({ type: 'error', data: { message: event.failedReason } });
        subscriber.complete();
      };

      this.queueEvents.on('progress', onProgress);
      this.queueEvents.on('completed', onCompleted);
      this.queueEvents.on('failed', onFailed);

      return () => {
        this.queueEvents.off('progress', onProgress);
        this.queueEvents.off('completed', onCompleted);
        this.queueEvents.off('failed', onFailed);
      };
    });
  }
}
