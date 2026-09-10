export default () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  // Credencial de serviço das rotas /internal, usada pelo Norman. Sem valor
  // configurado, nenhuma chamada interna é aceita.
  internal: {
    token: process.env.INTERNAL_API_TOKEN || '',
  },

  database: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  },

  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    // Índice do banco do Redis. Duas instâncias do serviço no mesmo Redis com o
    // mesmo índice compartilham as filas do BullMQ e roubam job uma da outra —
    // a de produção buscaria no Norman de produção um arquivo que só existe no
    // de develop. Um índice por ambiente separa as filas sem separar o Redis.
    db: parseInt(process.env.REDIS_DB || '0', 10),
  },

  ollama: {
    host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.1:8b-instruct-q4_0',
    embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
    visionModel: process.env.OLLAMA_VISION_MODEL || 'minicpm-v',
  },

  ingestion: {
    // Onde o Norman devolve os bytes de um arquivo do repositório.
    normanBaseUrl: process.env.NORMAN_INTERNAL_URL || '',
    fetchTimeoutMs: parseInt(process.env.INGESTION_FETCH_TIMEOUT_MS || '120000', 10),
    // Teto de tamanho do arquivo. Os extratores de formato binário carregam o
    // arquivo inteiro em memória, então este número é o que separa um acervo
    // pesado de um worker morto por OOM.
    maxFileBytes: parseInt(process.env.INGESTION_MAX_FILE_BYTES || '104857600', 10),
    maxExpandedFileBytes: parseInt(
      process.env.INGESTION_MAX_EXPANDED_FILE_BYTES || '314572800',
      10,
    ),
    // Tetos de estrutura: planilha e deck grandes viram muitos chunks e muitos
    // embeddings, e é a fila que paga a conta.
    maxSheets: parseInt(process.env.INGESTION_MAX_SHEETS || '100', 10),
    maxSlides: parseInt(process.env.INGESTION_MAX_SLIDES || '300', 10),
    // OCR de página escaneada custa mais de um minuto por página nesta máquina.
    // O teto existe para um PDF de 400 páginas não segurar a fila por um dia.
    ocrMaxPages: parseInt(process.env.INGESTION_OCR_MAX_PAGES || '20', 10),
    ocrTimeoutMs: parseInt(process.env.INGESTION_OCR_TIMEOUT_MS || '180000', 10),
    ocrScale: parseFloat(process.env.INGESTION_OCR_SCALE || '2'),
    // Teto de imagens de slide enviadas ao OCR por deck, pelo mesmo motivo do
    // teto de páginas de PDF.
    slideOcrMaxImages: parseInt(process.env.INGESTION_SLIDE_OCR_MAX_IMAGES || '20', 10),
    chunkSize: parseInt(process.env.INGESTION_CHUNK_SIZE || '1200', 10),
    chunkOverlap: parseInt(process.env.INGESTION_CHUNK_OVERLAP || '150', 10),
    embedBatchSize: parseInt(process.env.INGESTION_EMBED_BATCH_SIZE || '16', 10),
  },

  knowledge: {
    // O que o modelo lê de um documento para estudá-lo. Teto de caracteres, não
    // de tokens: é o que o extrator sabe medir sem chamar o modelo.
    excerptMaxChars: parseInt(process.env.KNOWLEDGE_EXCERPT_MAX_CHARS || '12000', 10),
    studyTimeoutMs: parseInt(process.env.KNOWLEDGE_STUDY_TIMEOUT_MS || '180000', 10),
    // O dossiê espera para não ser refeito uma vez por arquivo durante uma
    // rajada de envio: o id fixo do job junta a rajada inteira em um só.
    dossierDelayMs: parseInt(process.env.KNOWLEDGE_DOSSIER_DELAY_MS || '60000', 10),
    dossierMaxDocuments: parseInt(process.env.KNOWLEDGE_DOSSIER_MAX_DOCUMENTS || '25', 10),
    // Orçamento de contexto da recuperação. O piso de similaridade existe porque
    // o vizinho mais próximo de um acervo pequeno é sempre "o mais próximo",
    // mesmo sem relação com a pergunta; o teto de caracteres é o que impede um
    // trecho gigante de empurrar o resto do prompt para fora da janela.
    retrievalMinSimilarity: parseFloat(process.env.KNOWLEDGE_RETRIEVAL_MIN_SIMILARITY || '0.25'),
    retrievalMaxChars: parseInt(process.env.KNOWLEDGE_RETRIEVAL_MAX_CHARS || '8000', 10),
    retrievalMaxSnippets: parseInt(process.env.KNOWLEDGE_RETRIEVAL_MAX_SNIPPETS || '5', 10),
  },

  gateway: {
    // Teto de duração de uma chamada ao provedor de geração.
    timeoutMs: parseInt(process.env.GATEWAY_TIMEOUT_MS || '120000', 10),
    // Teto do teste administrativo de conexão. Mais curto que a geração de
    // propósito: quem está na tela esperando o resultado não espera dois
    // minutos para saber que a credencial não vale.
    connectionTestTimeoutMs: parseInt(process.env.GATEWAY_CONNECTION_TEST_TIMEOUT_MS || '15000', 10),
  },

  retention: {
    // Intervalo entre varreduras de retenção. A limpeza é idempotente e não
    // tem pressa: o que passou do prazo continua passado no próximo tique.
    sweepIntervalMs: parseInt(process.env.RETENTION_SWEEP_INTERVAL_MS || '3600000', 10),
    // Teto de linhas por varredura, para a limpeza não segurar o banco num
    // acervo antigo grande. O resto sai no tique seguinte.
    batchSize: parseInt(process.env.RETENTION_BATCH_SIZE || '5000', 10),
  },

  queue: {
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '2', 10),
    // A ingestão é trabalho de lote e disputa a mesma GPU do chat interativo:
    // ela anda mais devagar de propósito, para não travar a resposta na tela.
    ingestionConcurrency: parseInt(process.env.INGESTION_QUEUE_CONCURRENCY || '1', 10),
    knowledgeConcurrency: parseInt(process.env.KNOWLEDGE_QUEUE_CONCURRENCY || '1', 10),
    // Teto de duração TOTAL de uma resposta em streaming (não é timeout de inatividade).
    jobTimeoutMs: parseInt(process.env.QUEUE_JOB_TIMEOUT_MS || '300000', 10),
  },
});
