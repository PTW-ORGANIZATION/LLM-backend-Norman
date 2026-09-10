import { MigrationInterface, QueryRunner } from 'typeorm';

export class GenerationExecutions1757400000000 implements MigrationInterface {
  name = 'GenerationExecutions1757400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "generation_executions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "correlation_id" varchar(64) NOT NULL,
        "feature" varchar(64) NOT NULL,
        "client_id" varchar(255),
        "scope_path" text,
        "actor_user_id" varchar(255) NOT NULL,
        "activation_id" varchar(255) NOT NULL,
        "connection_key" varchar(64) NOT NULL,
        "connection_revision" integer NOT NULL,
        "model" varchar(255) NOT NULL,
        "attempt" integer NOT NULL,
        "fallback_of" varchar(64),
        "status" varchar(32) NOT NULL,
        "failure_kind" varchar(32),
        "failure_reason" text,
        "duration_ms" integer NOT NULL,
        "prompt_tokens" integer,
        "completion_tokens" integer,
        "evidence" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_generation_executions_correlation"
      ON "generation_executions" ("correlation_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_generation_executions_client"
      ON "generation_executions" ("client_id", "created_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "generation_executions";`);
  }
}
