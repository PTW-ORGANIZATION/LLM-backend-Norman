import { MigrationInterface, QueryRunner } from 'typeorm';

// A hierarquia de pastas do Norman é o escopo do conhecimento: cada documento e
// cada chunk guardam o cliente dono e o caminho da pasta. Uma consulta recupera
// dos níveis ancestrais do contexto, nunca dos irmãos e nunca de outro cliente.
//
// O escopo de pessoa (user_id + organization_id) e o escopo de cliente
// (client_id + scope_path) convivem: as colunas antigas passam a aceitar nulo e
// um CHECK exige que ao menos um dos dois esteja preenchido. Enquanto o
// searchSimilar continuar exigindo organization_id, linha de escopo de cliente
// simplesmente não casa — a busca de hoje não muda de comportamento.
export class KnowledgeScope1756720000000 implements MigrationInterface {
  name = 'KnowledgeScope1756720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------- DOCUMENTS ----------
    await queryRunner.query(`
      ALTER TABLE "documents"
        ALTER COLUMN "user_id" DROP NOT NULL,
        ALTER COLUMN "organization_id" DROP NOT NULL,
        ADD COLUMN "client_id" varchar(255),
        ADD COLUMN "scope_path" text,
        ADD COLUMN "sha256" varchar(64),
        ADD COLUMN "mime_type" varchar(255),
        ADD COLUMN "size_bytes" bigint,
        ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now();
    `);

    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD CONSTRAINT "chk_documents_scope"
      CHECK (
        ("user_id" IS NOT NULL AND "organization_id" IS NOT NULL)
        OR ("client_id" IS NOT NULL AND "scope_path" IS NOT NULL)
      );
    `);

    // text_pattern_ops porque as consultas de escopo são de prefixo: renomear ou
    // mover uma pasta é um UPDATE em "scope_path LIKE 'antigo/%'", e sem esta
    // classe de operador o índice não atende LIKE em locale não-C.
    await queryRunner.query(`
      CREATE INDEX "idx_documents_client_scope"
      ON "documents" ("client_id", "scope_path" text_pattern_ops);
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_documents_client_sha256"
      ON "documents" ("client_id", "sha256");
    `);

    // Um arquivo do repositório é um documento só: reenviar o mesmo caminho
    // atualiza a linha em vez de criar outra.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_documents_client_storage_path"
      ON "documents" ("client_id", "storage_path")
      WHERE "client_id" IS NOT NULL;
    `);

    // ---------- DOCUMENT_CHUNKS ----------
    await queryRunner.query(`
      ALTER TABLE "document_chunks"
        ALTER COLUMN "user_id" DROP NOT NULL,
        ALTER COLUMN "organization_id" DROP NOT NULL,
        ADD COLUMN "client_id" varchar(255),
        ADD COLUMN "scope_path" text,
        ADD COLUMN "page_number" integer;
    `);

    await queryRunner.query(`
      ALTER TABLE "document_chunks"
      ADD CONSTRAINT "chk_document_chunks_scope"
      CHECK (
        ("user_id" IS NOT NULL AND "organization_id" IS NOT NULL)
        OR ("client_id" IS NOT NULL AND "scope_path" IS NOT NULL)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_document_chunks_client_scope"
      ON "document_chunks" ("client_id", "scope_path" text_pattern_ops);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_document_chunks_client_scope";`);
    await queryRunner.query(`
      ALTER TABLE "document_chunks" DROP CONSTRAINT IF EXISTS "chk_document_chunks_scope";
    `);
    await queryRunner.query(`
      ALTER TABLE "document_chunks"
        DROP COLUMN IF EXISTS "page_number",
        DROP COLUMN IF EXISTS "scope_path",
        DROP COLUMN IF EXISTS "client_id";
    `);
    // A volta só é possível se nenhuma linha de escopo de cliente tiver sobrado —
    // por isso as colunas de escopo de pessoa voltam a NOT NULL depois do DROP.
    await queryRunner.query(`
      ALTER TABLE "document_chunks"
        ALTER COLUMN "organization_id" SET NOT NULL,
        ALTER COLUMN "user_id" SET NOT NULL;
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "uq_documents_client_storage_path";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_documents_client_sha256";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_documents_client_scope";`);
    await queryRunner.query(`ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "chk_documents_scope";`);
    await queryRunner.query(`
      ALTER TABLE "documents"
        DROP COLUMN IF EXISTS "updated_at",
        DROP COLUMN IF EXISTS "size_bytes",
        DROP COLUMN IF EXISTS "mime_type",
        DROP COLUMN IF EXISTS "sha256",
        DROP COLUMN IF EXISTS "scope_path",
        DROP COLUMN IF EXISTS "client_id";
    `);
    await queryRunner.query(`
      ALTER TABLE "documents"
        ALTER COLUMN "organization_id" SET NOT NULL,
        ALTER COLUMN "user_id" SET NOT NULL;
    `);
  }
}
