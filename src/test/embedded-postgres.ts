import { createServer } from 'node:net';
import type { DataSourceOptions } from 'typeorm';

export interface EmbeddedPostgres {
  options: DataSourceOptions;
  stop: () => Promise<void>;
}

export interface EmbeddedPostgresParams {
  entities: DataSourceOptions['entities'];
  migrations?: DataSourceOptions['migrations'];
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('Não consegui reservar uma porta livre.')));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

/**
 * O banco de integração desta suíte: `INGESTION_IT_DATABASE` quando definido,
 * senão um PostgreSQL embarcado com pgvector servido pelo protocolo de fio.
 */
export async function startIntegrationPostgres({
  entities,
  migrations,
}: EmbeddedPostgresParams): Promise<EmbeddedPostgres> {
  const external = process.env.INGESTION_IT_DATABASE;
  if (external) {
    return {
      options: {
        type: 'postgres',
        host: process.env.DB_HOST || '127.0.0.1',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: external,
        entities,
        migrations,
        synchronize: false,
      },
      stop: async () => {},
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const uuidOsspSpecifier = '@electric-sql/pglite/contrib/uuid_ossp';
  const uuidOsspModule: { uuid_ossp: typeof vector } = await import(uuidOsspSpecifier);
  const uuidOssp = uuidOsspModule.uuid_ossp;
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');

  const database = await PGlite.create({ extensions: { vector, uuidOssp } });
  const port = await freePort();
  const server = new PGLiteSocketServer({ db: database, host: '127.0.0.1', port, maxConnections: 4 });
  await server.start();

  return {
    options: {
      type: 'postgres',
      host: '127.0.0.1',
      port,
      username: 'postgres',
      password: 'postgres',
      database: 'postgres',
      entities,
      migrations,
      synchronize: false,
      extra: { max: 1 },
    },
    stop: async () => {
      await server.stop();
      await database.close();
    },
  };
}
