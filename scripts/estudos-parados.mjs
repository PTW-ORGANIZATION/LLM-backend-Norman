#!/usr/bin/env node
/**
 * Quantos documentos estão prontos e sem estudo, e há quanto tempo.
 *
 * A ingestão termina marcando o documento como pronto; o estudo é a etapa
 * seguinte e é ela que grava a nota. Documento pronto sem nota é o que a tela
 * do Norman mostra como "Estudando" — e, quando o estudo falhou de vez, ele
 * fica assim sem nada que o tire de lá.
 *
 * Este número é a medição que faltava: ninguém percebia o acúmulo até alguém
 * reparar na tela dias depois.
 */
import { Client } from 'pg';

const cliente = new Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

function emDias(data) {
  if (!data) return null;
  return Math.floor((Date.now() - new Date(data).getTime()) / 86400000);
}

try {
  await cliente.connect();

  const { rows: porStatus } = await cliente.query(
    'SELECT status, COUNT(*)::int AS total FROM documents GROUP BY status ORDER BY status',
  );
  console.log('documentos por situacao: '
    + (porStatus.map((linha) => `${linha.status}=${linha.total}`).join(' ') || 'nenhum'));

  const { rows: [parados] } = await cliente.query(
    `SELECT COUNT(*)::int AS total, MIN(d.updated_at) AS mais_antigo
       FROM documents d
      WHERE d.status = 'ready'
        AND NOT EXISTS (SELECT 1 FROM knowledge_notes n WHERE n.document_id = d.id)`,
  );

  if (!parados || parados.total === 0) {
    console.log('nenhum documento pronto sem estudo');
  } else {
    const dias = emDias(parados.mais_antigo);
    console.log(`PRONTOS SEM ESTUDO: ${parados.total}`
      + (dias === null ? '' : ` (o mais antigo ha ${dias} dia(s))`));

    const { rows: exemplos } = await cliente.query(
      `SELECT d.filename, d.updated_at
         FROM documents d
        WHERE d.status = 'ready'
          AND NOT EXISTS (SELECT 1 FROM knowledge_notes n WHERE n.document_id = d.id)
        ORDER BY d.updated_at
        LIMIT 10`,
    );
    for (const linha of exemplos) {
      console.log(`  ${linha.filename} — parado ha ${emDias(linha.updated_at)} dia(s)`);
    }
  }
} catch (erro) {
  console.log(`nao consegui medir os estudos parados: ${erro?.message || erro}`);
} finally {
  await cliente.end().catch(() => undefined);
}
