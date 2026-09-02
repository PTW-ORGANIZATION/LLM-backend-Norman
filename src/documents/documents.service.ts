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

  /**
   * Esquece um arquivo pelo caminho exato. Os chunks vão junto pelo ON DELETE
   * CASCADE da FK.
   */
  async forgetPath(input: { clientId: string; storagePath: string }): Promise<number> {
    const result = await this.documentsRepository.delete({
      clientId: input.clientId,
      storagePath: input.storagePath,
    });
    return result.affected ?? 0;
  }

  /**
   * Esquece uma pasta inteira e tudo abaixo dela.
   *
   * A comparação de prefixo é feita por `left(...)`, e não por `LIKE`: nome de
   * pasta do Norman é cheio de `_`, que é curinga de um caractere no `LIKE`, e um
   * padrão vindo do próprio caminho apagaria pasta irmã. Igualdade não tem
   * curinga.
   */
  async forgetPrefix(input: { clientId: string; scopePath: string }): Promise<number> {
    const result = await this.documentsRepository
      .createQueryBuilder()
      .delete()
      .where('client_id = :clientId', { clientId: input.clientId })
      .andWhere(
        '(scope_path = :prefix OR left(scope_path, length(:prefix) + 1) = :prefix || \'/\')',
        { prefix: input.scopePath },
      )
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Move o escopo de uma pasta para outro caminho **sem revetorizar**.
   *
   * O embedding descreve o texto, não o lugar onde o arquivo está: renomear uma
   * pasta com mil documentos não pode custar mil chamadas ao modelo. Documento e
   * chunk são atualizados na mesma transação, senão a busca passaria a recuperar
   * por um caminho que os documentos já não têm.
   */
  async renamePrefix(input: {
    clientId: string;
    fromPath: string;
    toPath: string;
  }): Promise<number> {
    if (input.fromPath === input.toPath) return 0;

    return this.documentsRepository.manager.transaction(async (manager) => {
      const scopeCondition =
        "(scope_path = $2 OR left(scope_path, length($2) + 1) = $2 || '/')";
      const movedScope = "$3 || substring(scope_path from length($2) + 1)";

      const documents = await manager.query(
        `UPDATE documents
            SET scope_path = ${movedScope},
                storage_path = CASE
                  WHEN left(storage_path, length($2) + 1) = $2 || '/'
                    THEN $3 || substring(storage_path from length($2) + 1)
                  ELSE storage_path
                END,
                updated_at = now()
          WHERE client_id = $1 AND ${scopeCondition}`,
        [input.clientId, input.fromPath, input.toPath],
      );

      await manager.query(
        `UPDATE document_chunks
            SET scope_path = ${movedScope}
          WHERE client_id = $1 AND ${scopeCondition}`,
        [input.clientId, input.fromPath, input.toPath],
      );

      return Array.isArray(documents) && typeof documents[1] === 'number' ? documents[1] : 0;
    });
  }
}
