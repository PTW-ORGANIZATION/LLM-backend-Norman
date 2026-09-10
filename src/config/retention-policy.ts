export type RetentionSubject =
  | 'temporaryAudio'
  | 'transcript'
  | 'conversation'
  | 'generationAudit';

export interface RetentionEntry {
  subject: RetentionSubject;
  /** Dias configurados, ou nulo quando ninguém decidiu ainda. */
  days: number | null;
  configured: boolean;
  env: string;
}

export const RETENTION_ENV: Record<RetentionSubject, string> = {
  temporaryAudio: 'RETENTION_TEMPORARY_AUDIO_DAYS',
  transcript: 'RETENTION_TRANSCRIPT_DAYS',
  conversation: 'RETENTION_CONVERSATION_DAYS',
  generationAudit: 'RETENTION_GENERATION_AUDIT_DAYS',
};

export type EnvSource = Record<string, string | undefined>;

/**
 * A política de retenção configurada, sujeito por sujeito.
 *
 * Não há padrão. Prazo de retenção é decisão de quem responde pelos dados, e
 * inventar um número aqui seria decidir no lugar dessa pessoa. Guardar para
 * sempre em silêncio também não serve: o que falta aparece como falta, e é o
 * `/health` que a mostra, para a pendência ser visível a quem opera em vez de
 * ficar escondida numa variável não preenchida.
 */
export function resolveRetentionPolicy(source: EnvSource = process.env): RetentionEntry[] {
  return (Object.keys(RETENTION_ENV) as RetentionSubject[]).map((subject) => {
    const env = RETENTION_ENV[subject];
    const raw = (source[env] || '').trim();
    const days = raw ? Number(raw) : Number.NaN;
    const valid = Number.isInteger(days) && days > 0;
    return { subject, days: valid ? days : null, configured: valid, env };
  });
}

export function pendingRetentionDecisions(source: EnvSource = process.env): RetentionSubject[] {
  return resolveRetentionPolicy(source)
    .filter((entry) => !entry.configured)
    .map((entry) => entry.subject);
}
