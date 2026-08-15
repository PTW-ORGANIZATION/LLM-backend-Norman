import { MigrationInterface, QueryRunner } from 'typeorm';

// Dimensão do modelo de embedding escolhido: nomic-embed-text (via Ollama) = 768 dimensões.
// Se trocar o modelo de embedding, ajuste VECTOR_DIM e regenere os embeddings existentes.
const VECTOR_DIM = 768;

export class InitialSchema1755230000000 implements MigrationInterface {
  name = 'InitialSchema1755230000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Extensão obrigatória para busca vetorial por similaridade
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    // ---------- USERS ----------
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "email" varchar(255) NOT NULL UNIQUE,
        "password_hash" varchar(255) NOT NULL,
        "name" varchar(255) NOT NULL,
        "role" varchar(50) NOT NULL DEFAULT 'user',
        "organization_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    // ---------- ORGANIZATIONS ----------
    await queryRunner.query(`
      CREATE TABLE "organizations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "name" varchar(255) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD CONSTRAINT "fk_users_organization"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL;
    `);

    // ---------- PROJECTS ----------
    await queryRunner.query(`
      CREATE TABLE "projects" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "name" varchar(255) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    // ---------- CONVERSATIONS ----------
    await queryRunner.query(`
      CREATE TABLE "conversations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
        "title" varchar(255),
        "summary" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    // ---------- MESSAGES ----------
    await queryRunner.query(`
      CREATE TABLE "messages" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
        "role" varchar(20) NOT NULL, -- 'user' | 'assistant' | 'system'
        "content" text NOT NULL,
        "token_count" integer,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX "idx_messages_conversation" ON "messages" ("conversation_id", "created_at");
    `);

    // ---------- MEMORIES (fatos/preferências persistentes) ----------
    await queryRunner.query(`
      CREATE TABLE "memories" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
        "content" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    // ---------- DOCUMENTS ----------
    await queryRunner.query(`
      CREATE TABLE "documents" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
        "filename" varchar(500) NOT NULL,
        "storage_path" varchar(1000) NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'pending', -- pending | processing | ready | failed
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    // ---------- DOCUMENT_CHUNKS (com embedding vetorial) ----------
    await queryRunner.query(`
      CREATE TABLE "document_chunks" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "user_id" uuid NOT NULL,
        "organization_id" uuid NOT NULL,
        "project_id" uuid,
        "chunk_index" integer NOT NULL,
        "content" text NOT NULL,
        "embedding" vector(${VECTOR_DIM}) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Índice HNSW para busca rápida por similaridade de cosseno — citado no documento (seção 9)
    await queryRunner.query(`
      CREATE INDEX "idx_document_chunks_embedding"
      ON "document_chunks"
      USING hnsw ("embedding" vector_cosine_ops);
    `);

    // Índices de segurança: TODA busca deve filtrar por estas colunas (regra crítica do documento, seção 4.2)
    await queryRunner.query(`
      CREATE INDEX "idx_document_chunks_scope"
      ON "document_chunks" ("organization_id", "user_id", "project_id");
    `);

    // ---------- AI_JOBS (auditoria da fila) ----------
    await queryRunner.query(`
      CREATE TABLE "ai_jobs" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
        "status" varchar(50) NOT NULL DEFAULT 'queued', -- queued|processing|completed|failed|cancelled|timeout
        "prompt_tokens" integer,
        "completion_tokens" integer,
        "latency_ms" integer,
        "error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "finished_at" timestamptz
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_jobs";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "document_chunks";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "documents";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "memories";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "messages";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversations";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "projects";`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "fk_users_organization";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "organizations";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users";`);
  }
}
