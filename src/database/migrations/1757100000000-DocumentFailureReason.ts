import { MigrationInterface, QueryRunner } from 'typeorm';

// Por que a ingestão de um documento falhou, em texto legível.
//
// Até aqui o motivo só existia no log do worker, e a tela do repositório
// mostrava "Não lido" sem dizer se o arquivo estava corrompido, protegido por
// senha, grande demais ou de um tipo que a camada não lê. Cada um desses casos
// pede uma ação diferente de quem enviou o arquivo, e nenhuma delas é
// adivinhável a partir do selo.
//
// `text` e não `varchar`: a mensagem carrega o nome do arquivo e o detalhe do
// extrator, e cortar isso na metade é exatamente perder a parte útil.
export class DocumentFailureReason1757100000000 implements MigrationInterface {
  name = 'DocumentFailureReason1757100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD COLUMN IF NOT EXISTS "failure_reason" text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents" DROP COLUMN IF EXISTS "failure_reason";
    `);
  }
}
