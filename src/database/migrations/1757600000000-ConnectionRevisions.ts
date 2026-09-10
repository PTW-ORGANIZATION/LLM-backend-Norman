import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConnectionRevisions1757600000000 implements MigrationInterface {
  name = 'ConnectionRevisions1757600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "connection_revisions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "connection_key" varchar(64) NOT NULL,
        "revision" integer NOT NULL,
        "model" varchar(255) NOT NULL,
        "config_digest" varchar(128) NOT NULL,
        "is_enabled" boolean NOT NULL DEFAULT true,
        "activation_id" varchar(255),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_connection_revisions_key_revision" UNIQUE ("connection_key", "revision")
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_connection_revisions_enabled"
      ON "connection_revisions" ("connection_key", "is_enabled", "revision");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "connection_revisions";`);
  }
}
