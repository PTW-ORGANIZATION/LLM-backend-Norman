import { MigrationInterface, QueryRunner } from 'typeorm';

// Qual extrator leu o documento: `pdf-text-layer`, `pdf-ocr`, `docx`, `doc`,
// `xlsx`, `xls`, `pptx`, `pptx-ocr` ou `plain`.
//
// Até aqui a origem só existia no log da fila, o que não responde a pergunta que
// aparece na operação: "esse PDF foi lido de verdade ou saiu do OCR?". A
// diferença muda a confiança na resposta do chat e decide se vale reprocessar o
// arquivo com outro modelo de visão.
//
// Fica nula nos documentos ingeridos antes desta coluna. Nulo aqui significa
// "não registrado", não "não extraído" — quem lê precisa tratar os dois casos.
export class DocumentExtractionSource1757000000000 implements MigrationInterface {
  name = 'DocumentExtractionSource1757000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD COLUMN IF NOT EXISTS "extraction_source" varchar(50);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents" DROP COLUMN IF EXISTS "extraction_source";
    `);
  }
}
