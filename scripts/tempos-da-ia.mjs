#!/usr/bin/env node
/**
 * Quanto tempo cada frente de IA passa dentro do provedor, e o que ela gasta.
 *
 * `generation_executions` grava uma linha por tentativa, com a duração da
 * chamada ao provedor e os tokens de entrada e de saída. É a única medição de
 * latência que já existe em produção, e ela responde a pergunta que decide
 * onde mexer: se a operação demora porque o modelo escreve muito, encurtar a
 * resposta vale mais do que paralelizar qualquer coisa em volta.
 *
 * A duração aqui é só a chamada ao provedor. O que o gateway faz antes —
 * revisão, dossiê, embedding, busca no acervo — fica de fora, e a diferença
 * entre este número e o que a tela mostra é o tamanho desse "antes".
 */
import { Client } from 'pg';

const cliente = new Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

const DIAS = Number(process.env.TEMPOS_DA_IA_DIAS || 14);

function segundos(ms) {
  if (ms === null || ms === undefined) return '-';
  return `${(Number(ms) / 1000).toFixed(1)}s`;
}

/**
 * O nome do modelo com as letras separadas.
 *
 * `GROK_MODEL` e `OLLAMA_MODEL` são secrets do ambiente, e o GitHub apaga do
 * log todo trecho igual a um secret: o modelo saía como `***`, que é
 * justamente o que se quer ler aqui. Nome de modelo não é sigilo.
 */
function modeloLegivel(modelo) {
  return String(modelo || '-').split('').join(' ');
}

function inteiro(valor) {
  if (valor === null || valor === undefined) return '-';
  return String(Math.round(Number(valor)));
}

try {
  await cliente.connect();

  const { rows } = await cliente.query(
    `SELECT feature,
            status,
            COUNT(*)::int                                                          AS chamadas,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms)               AS mediana,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)              AS p95,
            MAX(duration_ms)                                                       AS pior,
            AVG(prompt_tokens)                                                     AS entrada,
            AVG(completion_tokens)                                                 AS saida,
            MAX(completion_tokens)                                                 AS maior_saida
       FROM generation_executions
      WHERE created_at > now() - ($1 || ' days')::interval
      GROUP BY feature, status
      ORDER BY percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms) DESC NULLS LAST`,
    [String(DIAS)],
  );

  if (rows.length === 0) {
    console.log(`nenhuma geracao registrada nos ultimos ${DIAS} dias`);
  } else {
    console.log(`geracoes dos ultimos ${DIAS} dias (tempo so do provedor):`);
    console.log('operacao                       situacao   n   mediana  p95     pior    entrada saida  maior');
    for (const linha of rows) {
      console.log(
        [
          String(linha.feature).padEnd(30),
          String(linha.status).padEnd(10),
          String(linha.chamadas).padStart(3),
          segundos(linha.mediana).padStart(8),
          segundos(linha.p95).padStart(7),
          segundos(linha.pior).padStart(7),
          inteiro(linha.entrada).padStart(7),
          inteiro(linha.saida).padStart(6),
          inteiro(linha.maior_saida).padStart(6),
        ].join(' '),
      );
    }
  }

  // Tokens de saida por segundo: separa "o modelo e lento" de "o modelo
  // escreve demais". Sao consertos diferentes -- trocar de modelo, ou encurtar
  // o que se pede a ele.
  const { rows: velocidade } = await cliente.query(
    `SELECT feature,
            model,
            SUM(completion_tokens)::int AS tokens,
            SUM(duration_ms)::int       AS ms
       FROM generation_executions
      WHERE created_at > now() - ($1 || ' days')::interval
        AND status = 'succeeded'
        AND completion_tokens IS NOT NULL
        AND duration_ms > 0
      GROUP BY feature, model
      HAVING SUM(completion_tokens) > 0
      ORDER BY feature`,
    [String(DIAS)],
  );

  if (velocidade.length > 0) {
    console.log('');
    console.log('tokens de saida por segundo, por operacao e modelo:');
    for (const linha of velocidade) {
      const porSegundo = (linha.tokens / (linha.ms / 1000)).toFixed(1);
      console.log(`  ${String(linha.feature).padEnd(30)} ${String(linha.model).padEnd(28)} ${porSegundo} tok/s`);
    }
  }

  // Mediana por dia. A mediana de catorze dias não enxerga uma mudança de
  // ontem: ela fica presa às dezenas de chamadas de antes, e a melhora aparece
  // como um arredondamento. Separada por dia, ela aparece inteira.
  const { rows: porDia } = await cliente.query(
    `SELECT feature,
            created_at::date                                           AS dia,
            COUNT(*)::int                                              AS chamadas,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms)   AS mediana,
            AVG(completion_tokens)                                     AS saida
       FROM generation_executions
      WHERE created_at > now() - interval '7 days'
        AND status = 'succeeded'
      GROUP BY feature, created_at::date
      ORDER BY feature, dia`,
  );

  if (porDia.length > 0) {
    console.log('');
    console.log('mediana por dia, para ver mudanca recente separada do acumulado:');
    console.log('operacao                       dia          n   mediana  saida');
    for (const linha of porDia) {
      console.log(
        [
          String(linha.feature).padEnd(30),
          new Date(linha.dia).toISOString().slice(0, 10),
          String(linha.chamadas).padStart(3),
          segundos(linha.mediana).padStart(8),
          inteiro(linha.saida).padStart(6),
        ].join(' '),
      );
    }
  }

  const { rows: ultimas } = await cliente.query(
    `SELECT feature, status, duration_ms, completion_tokens, created_at,
            connection_key, connection_revision, model
       FROM generation_executions
      ORDER BY created_at DESC
      LIMIT 12`,
  );

  if (ultimas.length > 0) {
    console.log('');
    console.log('as ultimas doze chamadas, uma a uma:');
    for (const linha of ultimas) {
      console.log(
        `  ${new Date(linha.created_at).toISOString().slice(0, 16).replace('T', ' ')} `
          + `${String(linha.feature).padEnd(26)} ${String(linha.status).padEnd(10)} `
          + `${segundos(linha.duration_ms).padStart(7)} ${inteiro(linha.completion_tokens).padStart(5)} tokens `
          + `${linha.connection_key} r${linha.connection_revision} ${modeloLegivel(linha.model)}`,
      );
    }
  }

  const { rows: falhasRecentes } = await cliente.query(
    `SELECT created_at, feature, failure_kind, failure_reason, duration_ms,
            connection_key, connection_revision
       FROM generation_executions
      WHERE status <> 'succeeded'
      ORDER BY created_at DESC
      LIMIT 8`,
  );

  if (falhasRecentes.length > 0) {
    console.log('');
    console.log('as ultimas falhas, com o motivo gravado:');
    for (const linha of falhasRecentes) {
      console.log(
        `  ${new Date(linha.created_at).toISOString().slice(0, 16).replace('T', ' ')} `
          + `${String(linha.feature).padEnd(26)} ${String(linha.failure_kind).padEnd(16)} `
          + `${segundos(linha.duration_ms).padStart(7)} ${linha.connection_key} r${linha.connection_revision} `
          + `${String(linha.failure_reason || '-').slice(0, 200)}`,
      );
    }
  }

  const { rows: falhas } = await cliente.query(
    `SELECT feature, failure_kind, COUNT(*)::int AS total
       FROM generation_executions
      WHERE created_at > now() - ($1 || ' days')::interval
        AND status <> 'succeeded'
      GROUP BY feature, failure_kind
      ORDER BY total DESC
      LIMIT 10`,
    [String(DIAS)],
  );

  if (falhas.length > 0) {
    console.log('');
    console.log('tentativas que nao terminaram (cada uma custa o tempo inteiro antes de falhar):');
    for (const linha of falhas) {
      console.log(`  ${String(linha.feature).padEnd(30)} ${String(linha.failure_kind ?? 'sem motivo').padEnd(20)} ${linha.total}`);
    }
  }
} catch (erro) {
  console.error(`a medicao de tempos nao terminou: ${erro?.message ?? erro}`);
  process.exitCode = 0;
} finally {
  await cliente.end().catch(() => {});
}
