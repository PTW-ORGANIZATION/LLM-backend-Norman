export default () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
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
  },

  ollama: {
    host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.1:8b-instruct-q4_0',
    embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
  },

  queue: {
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '2', 10),
    // Teto de duração TOTAL de uma resposta em streaming (não é timeout de inatividade).
    jobTimeoutMs: parseInt(process.env.QUEUE_JOB_TIMEOUT_MS || '300000', 10),
  },
});
