import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentRecord, DocumentStatus } from './document.entity';

export interface RegisterClientDocumentInput {
  clientId: string;
  scopePath: string;
  storagePath: string;
  filename: string;
  sha256: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface RegisterClientDocumentResult {
  document: DocumentRecord;
  /** Falso quando o mesmo conteúdo já estava registrado naquele caminho. */
  changed: boolean;
}

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(DocumentRecord)
    private readonly documentsRepository: Repository<DocumentRecord>,
  ) {}

  findById(id: string): Promise<DocumentRecord | null> {
    return this.documentsRepository.findOne({ where: { id } });
  }

  /**
   * Registra (ou atualiza) o documento de um arquivo do repositório do Norman.
   *
   * A identidade de um documento é o par cliente + caminho de armazenamento, não
   * o conteúdo: reenviar o mesmo caminho atualiza a linha. O `sha256` decide se
   * há trabalho a fazer — conteúdo igual devolve `changed: false` e não mexe no
   * status, para que um resync não jogue fora chunks já vetorizados.
   */
  async registerClientDocument(
    input: RegisterClientDocumentInput,
  ): Promise<RegisterClientDocumentResult> {
    const existing = await this.documentsRepository.findOne({
      where: { clientId: input.clientId, storagePath: input.storagePath },
    });

    if (existing && existing.sha256 === input.sha256 && existing.status === DocumentStatus.READY) {
      return { document: existing, changed: false };
    }

    const patch = {
      clientId: input.clientId,
      scopePath: input.scopePath,
      storagePath: input.storagePath,
      filename: input.filename,
      sha256: input.sha256,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes === null || input.sizeBytes === undefined
        ? null
        : String(input.sizeBytes),
      status: DocumentStatus.PENDING,
    };

    const document = await this.documentsRepository.save(
      existing
        ? this.documentsRepository.merge(existing, patch)
        : this.documentsRepository.create(patch),
    );

    return { document, changed: true };
  }

  async updateStatus(id: string, status: DocumentStatus): Promise<void> {
    await this.documentsRepository.update(id, { status });
  }
}
