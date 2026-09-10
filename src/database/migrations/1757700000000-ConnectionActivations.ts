import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * O registro das ativações reconhecidas, separado da revisão.
 *
 * Aditiva de propósito: `connection_revisions.activation_id` continua existindo
 * e não é reescrito. As linhas que já tinham ativação são copiadas para cá, para
 * uma ativação válida antes desta migration continuar resolvendo depois dela.
 */
export class ConnectionActivations1757700000000 implements MigrationInterface {
  name = 'ConnectionActivations1757700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "connection_activations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "activation_id" varchar(255) NOT NULL,
        "connection_key" varchar(64) NOT NULL,
        "revision" integer NOT NULL,
        "model" varchar(255) NOT NULL,
        "config_digest" varchar(128) NOT NULL,
        "confirmed_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_connection_activations_activation" UNIQUE ("activation_id"),
        CONSTRAINT "uq_connection_activations_identity"
          UNIQUE ("activation_id", "connection_key", "revision")
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_connection_activations_revision"
      ON "connection_activations" ("connection_key", "revision");
    `);
    await queryRunner.query(`
      INSERT INTO "connection_activations"
        ("activation_id", "connection_key", "revision", "model", "config_digest")
      SELECT "activation_id", "connection_key", "revision", "model", "config_digest"
      FROM "connection_revisions"
      WHERE "activation_id" IS NOT NULL
      ON CONFLICT ("activation_id") DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "connection_activations";`);
  }
}
