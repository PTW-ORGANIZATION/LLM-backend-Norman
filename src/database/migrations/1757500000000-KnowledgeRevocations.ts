import { MigrationInterface, QueryRunner } from 'typeorm';

export class KnowledgeRevocations1757500000000 implements MigrationInterface {
  name = 'KnowledgeRevocations1757500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "knowledge_revocations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "client_id" varchar(255) NOT NULL,
        "kind" varchar(16) NOT NULL,
        "path" text NOT NULL,
        "reason" text,
        "revoked_at" timestamptz NOT NULL DEFAULT now(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_knowledge_revocations_kind" CHECK ("kind" IN ('path', 'prefix'))
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_knowledge_revocations_target"
      ON "knowledge_revocations" ("client_id", "kind", "path");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_knowledge_revocations_client"
      ON "knowledge_revocations" ("client_id", "revoked_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "knowledge_revocations";`);
  }
}
