import { MigrationInterface, QueryRunner } from 'typeorm';

export class KnowledgeNoteStaleness1757300000000 implements MigrationInterface {
  name = 'KnowledgeNoteStaleness1757300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "knowledge_notes"
      ADD COLUMN IF NOT EXISTS "stale_since" timestamptz,
      ADD COLUMN IF NOT EXISTS "stale_reason" text;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_knowledge_notes_stale"
      ON "knowledge_notes" ("client_id")
      WHERE "stale_since" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_knowledge_notes_stale";`);
    await queryRunner.query(`
      ALTER TABLE "knowledge_notes"
      DROP COLUMN IF EXISTS "stale_since",
      DROP COLUMN IF EXISTS "stale_reason";
    `);
  }
}
