import { MigrationInterface, QueryRunner } from 'typeorm';

// O que o modelo aprendeu sobre o acervo, em JSON validado, ao lado dos chunks.
//
// Uma nota é de documento (`document_id` preenchido) ou de cliente
// (`document_id` nulo, que é o dossiê consolidado). O par que identifica a nota
// muda conforme o caso, e por isso são dois índices únicos parciais em vez de um
// só: documento + tipo para a primeira família, cliente + tipo para a segunda.
//
// `model` e `generator_version` ficam gravados na linha para que trocar o modelo
// ou o prompt seja detectável sem reler o acervo: a nota velha continua servindo
// até ser regerada, e a comparação diz quais precisam disso.
export class KnowledgeNotes1756800000000 implements MigrationInterface {
  name = 'KnowledgeNotes1756800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "knowledge_notes" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "document_id" uuid REFERENCES "documents"("id") ON DELETE CASCADE,
        "client_id" varchar(255) NOT NULL,
        "scope_path" text,
        "kind" varchar(50) NOT NULL,
        "model" varchar(255) NOT NULL,
        "generator_version" integer NOT NULL DEFAULT 1,
        "source_fingerprint" varchar(64) NOT NULL,
        "content" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      ALTER TABLE "knowledge_notes"
      ADD CONSTRAINT "chk_knowledge_notes_scope"
      CHECK ("document_id" IS NULL OR "scope_path" IS NOT NULL);
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_knowledge_notes_document_kind"
      ON "knowledge_notes" ("document_id", "kind")
      WHERE "document_id" IS NOT NULL;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_knowledge_notes_client_kind"
      ON "knowledge_notes" ("client_id", "kind")
      WHERE "document_id" IS NULL;
    `);

    // Mesma classe de operador do índice de escopo das outras tabelas: as
    // consultas por pasta são de prefixo.
    await queryRunner.query(`
      CREATE INDEX "idx_knowledge_notes_client_scope"
      ON "knowledge_notes" ("client_id", "scope_path" text_pattern_ops);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_notes";`);
  }
}
