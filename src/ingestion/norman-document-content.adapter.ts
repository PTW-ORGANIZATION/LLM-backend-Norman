import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DocumentContent,
  DocumentContentPort,
  DocumentContentRequest,
} from './document-content.port';

/**
 * Busca os bytes na rota interna do Norman.
 *
 * O caminho do arquivo vai no corpo, não na URL: `storagePath` é caminho de
 * pasta de cliente, com acento, espaço e barra, e passá-lo por query string
 * convidaria a uma re-normalização no meio do caminho — e caminho já gravado
 * nunca pode ser re-sanitizado (`sanitizePathSegment` do Norman não é
 * idempotente).
 */
@Injectable()
export class NormanDocumentContentAdapter extends DocumentContentPort {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async fetch(request: DocumentContentRequest): Promise<DocumentContent> {
    const baseUrl = this.config.get<string>('ingestion.normanBaseUrl');
    if (!baseUrl) {
      throw new Error('NORMAN_INTERNAL_URL não configurado: não há de onde buscar o arquivo');
    }

    const token = this.config.get<string>('internal.token');
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/internal/repository/file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        clientId: request.clientId,
        storagePath: request.storagePath,
      }),
      signal: AbortSignal.timeout(this.config.get<number>('ingestion.fetchTimeoutMs', 120000)),
    });

    if (!response.ok) {
      throw new Error(
        `Norman devolveu ${response.status} ao buscar "${request.storagePath}" do cliente ${request.clientId}`,
      );
    }

    const contentType = response.headers.get('content-type');
    return {
      content: Buffer.from(await response.arrayBuffer()),
      filename: response.headers.get('x-filename') || request.filename,
      mimeType: contentType && !contentType.startsWith('application/octet-stream') ? contentType : null,
    };
  }
}
