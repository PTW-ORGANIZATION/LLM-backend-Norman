import { IsIn, IsInt, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const VISION_CONTRACT_VERSION = 1;

const DATA_URL_DE_IMAGEM = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export class TranscribeImageDto {
  @IsInt()
  @IsIn([VISION_CONTRACT_VERSION])
  contractVersion: number;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  correlationId: string;

  @IsString()
  @MaxLength(12_000_000)
  @Matches(DATA_URL_DE_IMAGEM, {
    message: 'a imagem precisa ser uma URL de dados base64 de png, jpeg, webp ou gif',
  })
  image: string;
}
