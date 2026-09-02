import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

type DependencyStatus = { ok: boolean; error?: string };

/**
 * Sonda de saúde do serviço. Aberta, sem guard: ela é o que o túnel e o
 * supervisor consultam, e nenhum dos dois carrega credencial.
 *
 * Por isso também não devolve versão, host, nome de banco nem mensagem de driver
 * — só se cada dependência responde. Detalhe de falha vai para o log, não para a
 * resposta.
 */
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async check() {
    const database = await this.probe(() => this.dataSource.query('SELECT 1'));

    return {
      status: database.ok ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      dependencies: { database },
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
