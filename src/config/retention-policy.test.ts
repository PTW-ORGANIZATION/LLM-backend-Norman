import { describe, expect, it } from 'vitest';
import { pendingRetentionDecisions, RETENTION_ENV, resolveRetentionPolicy } from './retention-policy';

describe('resolveRetentionPolicy', () => {
  it('sem configuração, nenhum prazo é assumido e todos ficam pendentes', () => {
    const policy = resolveRetentionPolicy({});

    expect(policy.every((entry) => entry.days === null && !entry.configured)).toBe(true);
    expect(pendingRetentionDecisions({})).toEqual([
      'temporaryAudio',
      'transcript',
      'conversation',
      'generationAudit',
    ]);
  });

  it('cada sujeito lê a própria variável', () => {
    const policy = resolveRetentionPolicy({
      [RETENTION_ENV.temporaryAudio]: '7',
      [RETENTION_ENV.generationAudit]: '365',
    });

    expect(policy.find((entry) => entry.subject === 'temporaryAudio')).toMatchObject({
      days: 7,
      configured: true,
    });
    expect(policy.find((entry) => entry.subject === 'generationAudit')?.days).toBe(365);
    expect(pendingRetentionDecisions({
      [RETENTION_ENV.temporaryAudio]: '7',
      [RETENTION_ENV.generationAudit]: '365',
    })).toEqual(['transcript', 'conversation']);
  });

  it.each([['0'], ['-1'], ['2.5'], ['sete'], ['   ']])(
    'valor inválido (%s) conta como não decidido, e não como zero',
    (raw) => {
      const policy = resolveRetentionPolicy({ [RETENTION_ENV.transcript]: raw });

      expect(policy.find((entry) => entry.subject === 'transcript')).toMatchObject({
        days: null,
        configured: false,
      });
    },
  );

  it('a política nomeia a variável de cada sujeito, para quem opera saber o que preencher', () => {
    expect(resolveRetentionPolicy({}).map((entry) => entry.env)).toEqual([
      'RETENTION_TEMPORARY_AUDIO_DAYS',
      'RETENTION_TRANSCRIPT_DAYS',
      'RETENTION_CONVERSATION_DAYS',
      'RETENTION_GENERATION_AUDIT_DAYS',
    ]);
  });
});
