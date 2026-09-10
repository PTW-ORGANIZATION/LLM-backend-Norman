import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { resolveRetentionPolicy, type RetentionSubject } from './retention-policy';

export interface RetentionSweepEntry {
  subject: RetentionSubject;
  /** Falso quando ninguém decidiu o prazo: nada é apagado. */
  enabled: boolean;
  days: number | null;
  removed: number;
}

export interface RetentionSweepReport {
  entries: RetentionSweepEntry[];
  removed: number;
  pendingDecision: RetentionSubject[];
}

/**
 * O que cada sujeito de retenção apaga neste serviço.
 *
 * Os sujeitos que não aparecem aqui são de outro dono — áudio temporário e
 * transcrição vivem no Norman — e por isso não são varridos daqui. Declarar
 * isso explicitamente evita a leitura de que a limpeza roda e não encontra
 * nada, quando na verdade ela nem é deste lado.
 */
const SWEEPS: Partial<Record<RetentionSubject, { table: string; column: string }[]>> = {
  generationAudit: [{ table: 'generation_executions', column: 'created_at' }],
  conversation: [
    { table: 'messages', column: 'created_at' },
    { table: 'conversations', column: 'created_at' },
  ],
};

/**
 * A limpeza dos dados que passaram do prazo aprovado.
 *
 * Sujeito sem prazo decidido **não é varrido**: uma variável vazia não é
 * autorização para apagar, e inventar um número aqui seria decidir no lugar de
 * quem responde pelos dados. A pendência aparece na saúde.
 *
 * Idempotente e em lotes: o que passou do prazo continua passado no tique
 * seguinte, e o teto por varredura impede a limpeza de segurar o banco num
 * acervo antigo grande.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async sweepOnce(source: Record<string, string | undefined> = process.env): Promise<RetentionSweepReport> {
    const policy = resolveRetentionPolicy(source);
    const batchSize = Math.max(1, this.config.get<number>('retention.batchSize', 5000));
    const entries: RetentionSweepEntry[] = [];

    for (const entry of policy) {
      const sweeps = SWEEPS[entry.subject];
      if (!sweeps || !entry.configured || entry.days === null) {
        entries.push({ subject: entry.subject, enabled: false, days: entry.days, removed: 0 });
        continue;
      }

      let removed = 0;
      for (const sweep of sweeps) {
        removed += await this.deleteOlderThan(sweep.table, sweep.column, entry.days, batchSize);
      }
      entries.push({ subject: entry.subject, enabled: true, days: entry.days, removed });
    }

    const report: RetentionSweepReport = {
      entries,
      removed: entries.reduce((total, entry) => total + entry.removed, 0),
      pendingDecision: entries.filter((entry) => !entry.enabled).map((entry) => entry.subject),
    };

    if (report.removed > 0) {
      this.logger.log(
        `Retenção: ${report.removed} linhas removidas (${entries
          .filter((entry) => entry.removed > 0)
          .map((entry) => `${entry.subject}=${entry.removed}`)
          .join(', ')}).`,
      );
    }
    return report;
  }

  private async deleteOlderThan(
    table: string,
    column: string,
    days: number,
    batchSize: number,
  ): Promise<number> {
    try {
      // O `ctid` no subselect é o que limita o lote sem exigir chave própria em
      // cada tabela varrida.
      const result = await this.dataSource.query(
        `DELETE FROM ${table}
          WHERE ctid IN (
            SELECT ctid FROM ${table}
             WHERE ${column} < now() - ($1 || ' days')::interval
             LIMIT $2
          )`,
        [String(days), batchSize],
      );
      return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    } catch (error) {
      this.logger.warn(
        `Retenção de ${table} falhou: ${error instanceof Error ? error.message : error}`,
      );
      return 0;
    }
  }
}
