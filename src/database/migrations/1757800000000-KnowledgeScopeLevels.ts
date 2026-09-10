import { MigrationInterface, QueryRunner } from 'typeorm';

// O nível do acervo passa a ser uma coluna, e não uma dedução.
//
// Antes existiam dois níveis implícitos, reconhecidos pela combinação de
// colunas preenchidas: escopo de pessoa (`user_id` + `organization_id`) e
// escopo de cliente (`client_id` + `scope_path`). O conhecimento geral do
// sistema é um terceiro, e ele não pode ser representado por ausência: uma
// linha sem `client_id` por acidente passaria a valer para todos os clientes.
//
// `knowledge_scope` é o discriminador persistido, e o CHECK exige que cada
// linha pertença a exatamente um nível com o dono que aquele nível requer:
// `client` com cliente, `system` sem cliente nenhum, `person` com pessoa e
// organização.
//
// A classificação das linhas existentes é determinística e não consulta nada
// fora da própria linha: quem tem `client_id` é `client`, quem não tem é
// `person`. Nenhuma linha nasce `system` nesta migração — o acervo geral começa
// vazio, e só entra nele o que for enviado explicitamente por essa porta.
export class KnowledgeScopeLevels1757800000000 implements MigrationInterface {
  name = 'KnowledgeScopeLevels1757800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------- DOCUMENTS ----------
    await queryRunner.query(`
      ALTER TABLE "documents" ADD COLUMN "knowledge_scope" varchar(16);
    `);
    await queryRunner.query(`
      UPDATE "documents"
         SET "knowledge_scope" = CASE WHEN "client_id" IS NOT NULL THEN 'client' ELSE 'person' END;
    `);
    await queryRunner.query(`
      ALTER TABLE "documents" ALTER COLUMN "knowledge_scope" SET NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "chk_documents_scope";
    `);
    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD CONSTRAINT "chk_documents_scope"
      CHECK (
        ("knowledge_scope" = 'person'
          AND "user_id" IS NOT NULL AND "organization_id" IS NOT NULL
          AND "client_id" IS NULL)
        OR ("knowledge_scope" = 'client'
          AND "client_id" IS NOT NULL AND "scope_path" IS NOT NULL
          AND "user_id" IS NULL AND "organization_id" IS NULL AND "project_id" IS NULL)
        OR ("knowledge_scope" = 'system'
          AND "client_id" IS NULL AND "scope_path" IS NOT NULL
          AND "user_id" IS NULL AND "organization_id" IS NULL AND "project_id" IS NULL)
      );
    `);

    // Um arquivo do acervo geral é um documento só, e a identidade dele é o
    // caminho: sem este índice, reenviar o mesmo caminho criaria uma segunda
    // linha e a busca devolveria as duas versões como se fossem documentos
    // diferentes. O índice do acervo de cliente não alcança estas linhas porque
    // é parcial em `client_id IS NOT NULL`.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_documents_system_storage_path"
      ON "documents" ("storage_path")
      WHERE "knowledge_scope" = 'system';
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_documents_scope_level"
      ON "documents" ("knowledge_scope", "scope_path" text_pattern_ops);
    `);

    // ---------- DOCUMENT_CHUNKS ----------
    await queryRunner.query(`
      ALTER TABLE "document_chunks" ADD COLUMN "knowledge_scope" varchar(16);
    `);
    await queryRunner.query(`
      UPDATE "document_chunks"
         SET "knowledge_scope" = CASE WHEN "client_id" IS NOT NULL THEN 'client' ELSE 'person' END;
    `);
    await queryRunner.query(`
      ALTER TABLE "document_chunks" ALTER COLUMN "knowledge_scope" SET NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "document_chunks" DROP CONSTRAINT IF EXISTS "chk_document_chunks_scope";
    `);
    await queryRunner.query(`
      ALTER TABLE "document_chunks"
      ADD CONSTRAINT "chk_document_chunks_scope"
      CHECK (
        ("knowledge_scope" = 'person'
          AND "user_id" IS NOT NULL AND "organization_id" IS NOT NULL
          AND "client_id" IS NULL)
        OR ("knowledge_scope" = 'client'
          AND "client_id" IS NOT NULL AND "scope_path" IS NOT NULL
          AND "user_id" IS NULL AND "organization_id" IS NULL AND "project_id" IS NULL)
        OR ("knowledge_scope" = 'system'
          AND "client_id" IS NULL AND "scope_path" IS NOT NULL
          AND "user_id" IS NULL AND "organization_id" IS NULL AND "project_id" IS NULL)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_document_chunks_scope_level"
      ON "document_chunks" ("knowledge_scope");
    `);

    // ---------- KNOWLEDGE_NOTES ----------
    await queryRunner.query(`
      ALTER TABLE "knowledge_notes" ADD COLUMN "knowledge_scope" varchar(16);
    `);
    await queryRunner.query(`UPDATE "knowledge_notes" SET "knowledge_scope" = 'client';`);
    await queryRunner.query(`
      ALTER TABLE "knowledge_notes"
        ALTER COLUMN "knowledge_scope" SET NOT NULL,
        ALTER COLUMN "client_id" DROP NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "knowledge_notes"
      ADD CONSTRAINT "chk_knowledge_notes_owner"
      CHECK (
        ("knowledge_scope" = 'client' AND "client_id" IS NOT NULL)
        OR ("knowledge_scope" = 'system' AND "client_id" IS NULL)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_knowledge_notes_scope_level"
      ON "knowledge_notes" ("knowledge_scope", "scope_path" text_pattern_ops);
    `);

    // ---------- KNOWLEDGE_REVOCATIONS ----------
    await queryRunner.query(`
      ALTER TABLE "knowledge_revocations" ADD COLUMN "knowledge_scope" varchar(16);
    `);
    await queryRunner.query(`UPDATE "knowledge_revocations" SET "knowledge_scope" = 'client';`);
    await queryRunner.query(`
      ALTER TABLE "knowledge_revocations"
        ALTER COLUMN "knowledge_scope" SET NOT NULL,
        ALTER COLUMN "client_id" DROP NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "knowledge_revocations"
      ADD CONSTRAINT "chk_knowledge_revocations_owner"
      CHECK (
        ("knowledge_scope" = 'client' AND "client_id" IS NOT NULL)
        OR ("knowledge_scope" = 'system' AND "client_id" IS NULL)
      );
    `);
    // O índice único de antes tinha `client_id` como primeira coluna, e num
    // acervo sem cliente ele deixaria de unificar: `NULL` nunca é igual a
    // `NULL`, então revogar duas vezes o mesmo caminho geral criaria duas
    // lápides. São dois índices parciais, um por nível, e cada `INSERT ... ON
    // CONFLICT` cita o predicado do seu.
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_knowledge_revocations_target";`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_knowledge_revocations_client_target"
      ON "knowledge_revocations" ("client_id", "kind", "path")
      WHERE "knowledge_scope" = 'client';
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_knowledge_revocations_system_target"
      ON "knowledge_revocations" ("kind", "path")
      WHERE "knowledge_scope" = 'system';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.refuseWhenSystemKnowledgeExists(queryRunner);

    await queryRunner.query(`DROP INDEX IF EXISTS "uq_knowledge_revocations_system_target";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_knowledge_revocations_client_target";`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_knowledge_revocations_target"
      ON "knowledge_revocations" ("client_id", "kind", "path");
    `);
    await queryRunner.query(`
      ALTER TABLE "knowledge_revocations"
        DROP CONSTRAINT IF EXISTS "chk_knowledge_revocations_owner";
    `);
    await queryRunner.query(`
      ALTER TABLE "knowledge_revocations"
        ALTER COLUMN "client_id" SET NOT NULL,
        DROP COLUMN IF EXISTS "knowledge_scope";
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_knowledge_notes_scope_level";`);
    await queryRunner.query(`
      ALTER TABLE "knowledge_notes" DROP CONSTRAINT IF EXISTS "chk_knowledge_notes_owner";
    `);
    await queryRunner.query(`
      ALTER TABLE "knowledge_notes"
        ALTER COLUMN "client_id" SET NOT NULL,
        DROP COLUMN IF EXISTS "knowledge_scope";
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_document_chunks_scope_level";`);
    await queryRunner.query(`
      ALTER TABLE "document_chunks" DROP CONSTRAINT IF EXISTS "chk_document_chunks_scope";
    `);
    await queryRunner.query(`
      ALTER TABLE "document_chunks" DROP COLUMN IF EXISTS "knowledge_scope";
    `);
    await queryRunner.query(`
      ALTER TABLE "document_chunks"
      ADD CONSTRAINT "chk_document_chunks_scope"
      CHECK (
        ("user_id" IS NOT NULL AND "organization_id" IS NOT NULL)
        OR ("client_id" IS NOT NULL AND "scope_path" IS NOT NULL)
      );
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_documents_scope_level";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_documents_system_storage_path";`);
    await queryRunner.query(`
      ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "chk_documents_scope";
    `);
    await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN IF EXISTS "knowledge_scope";`);
    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD CONSTRAINT "chk_documents_scope"
      CHECK (
        ("user_id" IS NOT NULL AND "organization_id" IS NOT NULL)
        OR ("client_id" IS NOT NULL AND "scope_path" IS NOT NULL)
      );
    `);
  }

  private async refuseWhenSystemKnowledgeExists(queryRunner: QueryRunner): Promise<void> {
    const [contagem] = await queryRunner.query(`
      SELECT
        (SELECT count(*) FROM "documents" WHERE "knowledge_scope" = 'system')::int AS documentos,
        (SELECT count(*) FROM "document_chunks" WHERE "knowledge_scope" = 'system')::int AS chunks,
        (SELECT count(*) FROM "knowledge_notes" WHERE "knowledge_scope" = 'system')::int AS notas,
        (SELECT count(*) FROM "knowledge_revocations" WHERE "knowledge_scope" = 'system')::int
          AS revogacoes
    `);

    const total = Number(contagem.documentos) + Number(contagem.chunks)
      + Number(contagem.notas) + Number(contagem.revogacoes);
    if (total === 0) return;

    throw new Error(
      'A reversão de KnowledgeScopeLevels1757800000000 foi interrompida antes de excluir '
      + 'qualquer linha: o acervo geral do sistema tem conteúdo e o modelo anterior não sabe '
      + `representá-lo (${contagem.documentos} documento(s), ${contagem.chunks} trecho(s), `
      + `${contagem.notas} nota(s) e ${contagem.revogacoes} revogação(ões)). Exporte essas linhas `
      + 'e remova o conteúdo geral por decisão operacional explícita antes de reverter. '
      + 'Nenhuma linha de cliente ou de pessoa foi alterada.',
    );
  }
}
