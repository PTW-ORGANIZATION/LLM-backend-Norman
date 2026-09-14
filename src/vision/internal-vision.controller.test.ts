import { beforeEach, describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { InternalVisionController } from './internal-vision.controller';
import { TranscribeImageDto, VISION_CONTRACT_VERSION } from './transcribe-image.dto';

const PNG = 'data:image/png;base64,AAAA';

function validar(payload: Record<string, unknown>) {
  const dto = plainToInstance(TranscribeImageDto, payload);
  return validateSync(dto as object, { whitelist: true, forbidNonWhitelisted: true });
}

const VALIDO = {
  contractVersion: VISION_CONTRACT_VERSION,
  correlationId: 'corr-1',
  image: PNG,
};

describe('TranscribeImageDto', () => {
  it('aceita o contrato mínimo', () => {
    expect(validar(VALIDO)).toEqual([]);
  });

  it('recusa versão de contrato desencontrada', () => {
    expect(validar({ ...VALIDO, contractVersion: 99 }).map((e) => e.property)).toContain('contractVersion');
  });

  it('recusa o que não é URL de dados de imagem', () => {
    for (const image of ['https://exemplo/foto.png', 'data:application/pdf;base64,AAAA', 'AAAA']) {
      expect(validar({ ...VALIDO, image }).map((e) => e.property)).toContain('image');
    }
  });
});

describe('InternalVisionController', () => {
  const vision = { transcribeImageWithDiagnosis: vi.fn() };
  const config = { get: vi.fn().mockReturnValue(1000) };
  const controller = new InternalVisionController(config as any, vision as any);

  beforeEach(() => {
    vision.transcribeImageWithDiagnosis.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('devolve o texto lido e o modelo que leu', async () => {
    vision.transcribeImageWithDiagnosis.mockResolvedValue({
      text: 'VENHA SELEBRAR',
      model: 'minicpm-v',
      rawLength: 14,
      sentinel: false,
    });

    const resposta = await controller.transcribe({ ...VALIDO } as TranscribeImageDto);

    expect(resposta.text).toBe('VENHA SELEBRAR');
    expect(resposta.model).toBe('minicpm-v');
    expect(resposta.semTextoLegivel).toBe(false);
    expect(resposta.correlationId).toBe('corr-1');
  });

  // Texto vazio e texto lido precisam chegar distintos: quem chama anuncia
  // "sem erros" com base nisso, e anunciar ausência de erro para uma arte que
  // ninguém leu encerra a conferência humana com garantia falsa.
  it('marca quando não houve texto legível', async () => {
    vision.transcribeImageWithDiagnosis.mockResolvedValue({
      text: '',
      model: 'minicpm-v',
      rawLength: 0,
      sentinel: true,
    });

    const resposta = await controller.transcribe({ ...VALIDO } as TranscribeImageDto);

    expect(resposta.semTextoLegivel).toBe(true);
  });

  it('entrega ao modelo os bytes da imagem, e não a URL de dados', async () => {
    vision.transcribeImageWithDiagnosis.mockResolvedValue({
      text: 'ok', model: 'minicpm-v', rawLength: 2, sentinel: false,
    });

    await controller.transcribe({ ...VALIDO } as TranscribeImageDto);

    const [bytes] = vision.transcribeImageWithDiagnosis.mock.calls[0];
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString('base64')).toBe('AAAA');
  });
});
