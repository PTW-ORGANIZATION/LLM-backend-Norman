import { InitialSchema1755230000000 } from '../database/migrations/1755230000000-InitialSchema';
import { KnowledgeScope1756720000000 } from '../database/migrations/1756720000000-KnowledgeScope';
import { KnowledgeNotes1756800000000 } from '../database/migrations/1756800000000-KnowledgeNotes';
import { DocumentExtractionSource1757000000000 } from '../database/migrations/1757000000000-DocumentExtractionSource';
import { DocumentFailureReason1757100000000 } from '../database/migrations/1757100000000-DocumentFailureReason';
import { ChunkEmbeddingProvenance1757200000000 } from '../database/migrations/1757200000000-ChunkEmbeddingProvenance';
import { KnowledgeNoteStaleness1757300000000 } from '../database/migrations/1757300000000-KnowledgeNoteStaleness';
import { GenerationExecutions1757400000000 } from '../database/migrations/1757400000000-GenerationExecutions';
import { KnowledgeRevocations1757500000000 } from '../database/migrations/1757500000000-KnowledgeRevocations';
import { ConnectionRevisions1757600000000 } from '../database/migrations/1757600000000-ConnectionRevisions';
import { ConnectionActivations1757700000000 } from '../database/migrations/1757700000000-ConnectionActivations';
import { KnowledgeScopeLevels1757800000000 } from '../database/migrations/1757800000000-KnowledgeScopeLevels';

export const KNOWLEDGE_MIGRATIONS = [
  InitialSchema1755230000000,
  KnowledgeScope1756720000000,
  KnowledgeNotes1756800000000,
  DocumentExtractionSource1757000000000,
  DocumentFailureReason1757100000000,
  ChunkEmbeddingProvenance1757200000000,
  KnowledgeNoteStaleness1757300000000,
  GenerationExecutions1757400000000,
  KnowledgeRevocations1757500000000,
  ConnectionRevisions1757600000000,
  ConnectionActivations1757700000000,
  KnowledgeScopeLevels1757800000000,
];
