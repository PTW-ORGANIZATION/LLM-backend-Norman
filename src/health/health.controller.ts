import { Controller, Get } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { pendingRetentionDecisions, resolveRetentionPolicy } from '../config/retention-policy';
import { GENERATION_CONTRACT_VERSION } from '../gateway/generation.dto';
import { GENERATION_STREAM_CONTRACT_VERSION } from '../gateway/generation-stream.contract';
import { listConnections } from '../gateway/provider-connection';
import { INGESTION_JOBS_QUEUE_NAME } from '../queue/queue.constants';

type DependencyStatus = { ok: boolean };

/**
 * Sonda de saúde do serviço. Aberta, sem guard: ela é o que o túnel e o
 * supervisor consultam, e nenhum dos dois carrega credencial.
 *
 * Por isso também não devolve versão, host, nome de banco nem mensagem de driver
 * — só se cada dependência responde. Detalhe de falha vai para o log, não para a
 * resposta.
 *
 * As camadas ficam separadas porque cada uma quebra sozinha e exige uma ação
 * diferente: processo de pé com banco fora é uma coisa, banco de pé com nenhuma
 * conexão de provedor provisionada é outra, e nenhuma das duas se resolve
 * reiniciando o que estiver saudável.
 *
 * O provedor **não** é sondado aqui: alcançá-lo custa uma chamada paga a cada
 * verificação de saúde, e quem quer essa resposta tem o teste administrativo de
 * conexão, que é deliberado.
 */
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue(INGESTION_JOBS_QUEUE_NAME) private readonly queue?: Queue,
  ) {}

  @Get()
  async check() {
    const database = await this.probe(() => this.dataSource.query('SELECT 1'));
    const queue = await this.probe(async () => {
      if (!this.queue) throw new Error('fila não configurada');
      const client = (await this.queue.client) as { ping?: () => Promise<string> };
      if (typeof client?.ping !== 'function') throw new Error('fila sem cliente');
      return client.ping();
    });

    const connections = listConnections();
    const provisioned = connections.filter((connection) => connection.available);
    const gateway = { ok: provisioned.length > 0 };

    const healthy = database.ok && queue.ok && gateway.ok;

    return {
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      dependencies: { database, queue, gateway },
      gateway: {
        contractVersion: GENERATION_CONTRACT_VERSION,
        streamContractVersion: GENERATION_STREAM_CONTRACT_VERSION,
        // Só a chave e se está provisionada. Nem URL, nem modelo, nem o nome da
        // variável que falta: esta rota é aberta.
        connections: connections.map((connection) => ({
          key: connection.key,
          provisioned: connection.available,
        })),
      },
      // Só quais sujeitos ainda não têm prazo decidido, e nunca o valor
      // configurado: prazo é configuração, e esta rota é aberta.
      retention: {
        configured: resolveRetentionPolicy().filter((entry) => entry.configured).map((entry) => entry.subject),
        pendingDecision: pendingRetentionDecisions(),
      },
    };
  }

  private async probe(run: () => Promise<unknown>): Promise<DependencyStatus> {
    try {
      await run();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
}
