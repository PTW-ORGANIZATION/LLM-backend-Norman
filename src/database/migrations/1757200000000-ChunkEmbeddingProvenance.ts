import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChunkEmbeddingProvenance1757200000000 implements MigrationInterface {
  name = 'ChunkEmbeddingProvenance1757200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "document_chunks"
      ADD COLUMN IF NOT EXISTS "embedding_model" text,
      ADD COLUMN IF NOT EXISTS "embedding_dimensions" integer;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_document_chunks_embedding_model"
      ON "document_chunks" ("embedding_model");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_document_chunks_embedding_model";
    `);
    await queryRunner.query(`
      ALTER TABLE "document_chunks"
      DROP COLUMN IF EXISTS "embedding_model",
      DROP COLUMN IF EXISTS "embedding_dimensions";
    `);
  }
}
