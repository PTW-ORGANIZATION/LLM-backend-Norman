import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { InternalCapabilityGuard } from '../auth/internal-capability.guard';
import { RequiresCapability } from '../auth/internal-capabilities';
import { OllamaVisionService } from '../ollama/ollama-vision.service';
import { reduzirArteParaLeitura } from './reduzir-arte';
import { TranscribeImageDto, VISION_CONTRACT_VERSION } from './transcribe-image.dto';

function bytesDaDataUrl(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/**
 * A leitura de texto em imagem, para consumidores internos.
 *
 * Existe porque a revisão de arte do Norman lia com um OCR clássico e enxergava
 * a textura das fotos em vez do título da peça, produzindo apontamento sobre
 * texto que não existe. O modelo de visão daqui lê composição, e é o mesmo que
 * já transcreve imagem no acervo de conhecimento.
 */
@UseGuards(InternalAuthGuard, InternalCapabilityGuard)
@Controller('internal/vision')
export class InternalVisionController {
  private readonly logger = new Logger(InternalVisionController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly vision: OllamaVisionService,
  ) {}

  @RequiresCapability('documents.extract')
  @Post('transcribe')
  async transcribe(@Body() dto: TranscribeImageDto) {
    const recebida = bytesDaDataUrl(dto.image);
    const arte = await reduzirArteParaLeitura(recebida);
    const comecou = Date.now();
    const resultado = await this.vision.transcribeImageWithDiagnosis(arte.imagem, {
      timeoutMs: this.config.get<number>('ingestion.ocrTimeoutMs', 180000),
    });

    this.logger.log(
      `transcrição [correlationId=${dto.correlationId} bytes=${recebida.length} `
        + `${arte.reduzida ? `reduzida=${arte.largura}x${arte.altura} enviados=${arte.imagem.length} ` : ''}`
        + `modelo=${resultado.model} caracteres=${resultado.text.length} `
        + `duracao=${Date.now() - comecou}ms]`,
    );

    return {
      contractVersion: VISION_CONTRACT_VERSION,
      correlationId: dto.correlationId,
      text: resultado.text,
      model: resultado.model,
      semTextoLegivel: resultado.text.length === 0,
    };
  }
}
