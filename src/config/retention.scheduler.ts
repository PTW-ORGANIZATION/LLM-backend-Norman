import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { pendingRetentionDecisions } from './retention-policy';
import { RetentionService } from './retention.service';

/**
 * Roda a limpeza de retenção de tempos em tempos.
 *
 * O primeiro tique acontece na subida, e é ele que registra no log quais
 * sujeitos ainda estão sem prazo decidido: uma variável não preenchida some do
 * campo de visão, e a pendência precisa aparecer em algum lugar que quem opera
 * lê.
 *
 * A limpeza é idempotente, então rodar em mais de uma réplica não estraga nada
 * — no máximo uma delas encontra o lote já apagado pela outra.
 */
@Injectable()
export class RetentionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly retention: RetentionService,
  ) {}

  onModuleInit(): void {
    const pendentes = pendingRetentionDecisions();
    if (pendentes.length > 0) {
      this.logger.warn(
        `Retenção sem prazo decidido: ${pendentes.join(', ')}. A limpeza desses dados ` +
          'fica desligada até alguém decidir o prazo.',
      );
    }

    const intervalo = Math.max(60_000, this.config.get<number>('retention.sweepIntervalMs', 3600000));
    this.timer = setInterval(() => void this.tick(), intervalo);
    this.timer.unref?.();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.retention.sweepOnce();
    } catch (error) {
      this.logger.warn(
        `Varredura de retenção falhou: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      this.running = false;
    }
  }
}
