export const AI_JOBS_QUEUE_NAME = 'ai-jobs';
export const AI_JOBS_QUEUE_EVENTS = Symbol('AI_JOBS_QUEUE_EVENTS');

export const INGESTION_JOBS_QUEUE_NAME = 'ingestion-jobs';

// O estudo do acervo (notas e dossiê) tem fila própria: é trabalho de GPU mais
// caro que a vetorização e precisa de vazão regulada em separado.
export const KNOWLEDGE_JOBS_QUEUE_NAME = 'knowledge-jobs';
