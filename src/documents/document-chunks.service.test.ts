import { beforeEach, describe, expect, it } from 'vitest';
import { DocumentChunksService, SearchScope } from './document-chunks.service';

interface Row {
  content: string;
  userId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  clientId?: string | null;
  scopePath?: string | null;
}

type Parameters = Record<string, unknown>;

// Cada cláusula que o serviço sabe emitir, traduzida para uma função sobre a
// linha. Comparação com NULL é falsa, como no Postgres — é exatamente disso que
// depende o isolamento entre escopo de pessoa e escopo de cliente.
const PREDICATES: Record<string, (row: Row, params: Parameters) => boolean> = {
  'chunk.user_id = :userId': (row, params) =>
    row.userId != null && row.userId === params.userId,
  'chunk.organization_id = :organizationId': (row, params) =>
    row.organizationId != null && row.organizationId === params.organizationId,
  '(chunk.project_id = :projectId OR chunk.project_id IS NULL)': (row, params) =>
    row.projectId == null || row.projectId === params.projectId,
  'chunk.client_id = :clientId': (row, params) =>
    row.clientId != null && row.clientId === params.clientId,
  'chunk.scope_path IN (:...ancestors)': (row, params) =>
    row.scopePath != null && (params.ancestors as string[]).includes(row.scopePath),
};

class FakeQueryBuilder {
  private readonly clauses: string[] = [];
  private readonly parameters: Parameters = {};
  private rowLimit = Number.MAX_SAFE_INTEGER;

  constructor(private readonly rows: Row[], private readonly repository: FakeRepository) {}

  select() {
    return this;
  }

  where(clause: string, params?: Parameters) {
    return this.andWhere(clause, params);
  }

  andWhere(clause: string, params?: Parameters) {
    if (!PREDICATES[clause]) {
      throw new Error(`Cláusula não prevista pelo teste de isolamento: ${clause}`);
    }
    this.clauses.push(clause);
    Object.assign(this.parameters, params ?? {});
    return this;
  }

  orderBy() {
    return this;
  }

  setParameter(name: string, value: unknown) {
    this.parameters[name] = value;
    return this;
  }

  limit(value: number) {
    this.rowLimit = value;
    return this;
  }

  async getRawMany(): Promise<Array<{ content: string }>> {
    this.repository.executed = true;
    return this.rows
      .filter((row) => this.clauses.every((clause) => PREDICATES[clause](row, this.parameters)))
      .slice(0, this.rowLimit)
      .map((row) => ({ content: row.content }));
  }
}

class FakeRepository {
  executed = false;

  constructor(private readonly rows: Row[]) {}

  createQueryBuilder() {
    return new FakeQueryBuilder(this.rows, this);
  }
}

const EMBEDDING = Array.from({ length: 768 }, () => 0.01);

const ROWS: Row[] = [
  {
    content: 'brand guide da Acme',
    clientId: 'acme',
    scopePath: 'AcmeCorp',
    userId: null,
    organizationId: null,
    projectId: null,
  },
  {
    content: 'campanha de verao da Acme',
    clientId: 'acme',
    scopePath: 'AcmeCorp/Campanhas/Verao2026',
    userId: null,
    organizationId: null,
    projectId: null,
  },
  {
    content: 'campanha de inverno da Acme',
    clientId: 'acme',
    scopePath: 'AcmeCorp/Campanhas/Inverno2026',
    userId: null,
    organizationId: null,
    projectId: null,
  },
  {
    content: 'segredo da Rival, mesmo caminho de pasta',
    clientId: 'rival',
    scopePath: 'AcmeCorp/Campanhas/Verao2026',
    userId: null,
    organizationId: null,
    projectId: null,
  },
  {
    content: 'nota pessoal do usuario',
    clientId: null,
    scopePath: null,
    userId: 'user-1',
    organizationId: 'org-1',
    projectId: null,
  },
];

function serviceWith(rows: Row[]) {
  const repository = new FakeRepository(rows);
  const service = new DocumentChunksService(repository as never);
  return { service, repository };
}

function search(scope: SearchScope, rows: Row[] = ROWS) {
  const { service, repository } = serviceWith(rows);
  return { result: service.searchSimilar({ scope, embedding: EMBEDDING }), repository };
}

const acmeVerao: SearchScope = {
  kind: 'client',
  clientId: 'acme',
  scopePath: 'AcmeCorp/Campanhas/Verao2026',
};

describe('DocumentChunksService.searchSimilar — isolamento por cliente', () => {
  let contents: (scope: SearchScope, rows?: Row[]) => Promise<string[]>;

  beforeEach(() => {
    contents = async (scope, rows) => (await search(scope, rows).result).map((row) => row.content);
  });

  it('recupera os ancestrais do próprio caminho', async () => {
    expect(await contents(acmeVerao)).toEqual([
      'brand guide da Acme',
      'campanha de verao da Acme',
    ]);
  });

  it('não alcança pasta irmã', async () => {
    expect(await contents(acmeVerao)).not.toContain('campanha de inverno da Acme');
  });

  it('consulta no escopo de outro cliente volta vazia', async () => {
    const outroCliente: SearchScope = {
      kind: 'client',
      clientId: 'desconhecido',
      scopePath: 'AcmeCorp/Campanhas/Verao2026',
    };
    expect(await contents(outroCliente)).toEqual([]);
  });

  it('mesmo caminho de pasta em outro cliente não vaza', async () => {
    expect(await contents(acmeVerao)).not.toContain('segredo da Rival, mesmo caminho de pasta');

    const rival: SearchScope = { ...acmeVerao, clientId: 'rival' };
    expect(await contents(rival)).toEqual(['segredo da Rival, mesmo caminho de pasta']);
  });

  it('escopo de cliente não alcança linha de escopo de pessoa', async () => {
    expect(await contents(acmeVerao)).not.toContain('nota pessoal do usuario');
  });

  it('escopo de pessoa não alcança linha de escopo de cliente', async () => {
    const pessoa: SearchScope = {
      kind: 'person',
      userId: 'user-1',
      organizationId: 'org-1',
      projectId: null,
    };
    expect(await contents(pessoa)).toEqual(['nota pessoal do usuario']);
  });
});

describe('DocumentChunksService.searchSimilar — escopo sem trava não consulta', () => {
  it('cliente com caminho de travessia devolve vazio sem ir ao banco', async () => {
    const { result, repository } = search({
      kind: 'client',
      clientId: 'acme',
      scopePath: 'AcmeCorp/../Rival',
    });
    expect(await result).toEqual([]);
    expect(repository.executed).toBe(false);
  });

  it('cliente sem id devolve vazio sem ir ao banco', async () => {
    const { result, repository } = search({
      kind: 'client',
      clientId: '',
      scopePath: 'AcmeCorp',
    });
    expect(await result).toEqual([]);
    expect(repository.executed).toBe(false);
  });

  it('pessoa sem organização devolve vazio sem ir ao banco', async () => {
    const { result, repository } = search({
      kind: 'person',
      userId: 'user-1',
      organizationId: null,
      projectId: null,
    });
    expect(await result).toEqual([]);
    expect(repository.executed).toBe(false);
  });
});
