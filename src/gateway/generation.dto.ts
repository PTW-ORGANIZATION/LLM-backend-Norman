import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { GENERATION_FEATURES } from './feature-registry';
import { PROVIDER_KEYS } from './provider-connection';
import { FALLBACK_ELIGIBLE_KINDS } from './llm-provider.port';
import { BRAND_TOKEN_KINDS, BRAND_TOKEN_PROVENANCES } from './brand-tokens';
import { IsObject } from 'class-validator';

/**
 * A versão do contrato interno de geração.
 *
 * Subiu para 2 quando o fallback passou a carregar a revisão e o modelo
 * aprovados. A recusa por versão é o que impede combinação desencontrada de
 * publicação: um consumidor que ainda mande a versão 1 manda um fallback sem
 * revisão, e aceitá-lo obrigaria este executor a escolher uma revisão por
 * aproximação — o defeito que a versão nova fecha.
 */
export const GENERATION_CONTRACT_VERSION = 2;

const SAFE_PATH = /^[^\\]*$/;

/**
 * Imagem de entrada, como URL de dados.
 *
 * O formato é o mesmo que o protocolo OpenAI já usa em `image_url`, então ela
 * atravessa o adaptador sem tradução. Só os tipos que os provedores de visão
 * aceitam: recusar aqui dá mensagem clara, enquanto deixar passar devolve um
 * erro do provedor que não diz qual arquivo era.
 */
const DATA_URL_DE_IMAGEM = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export class GenerationMessageDto {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  @MinLength(1)
  @MaxLength(200000)
  content: string;

  /**
   * As imagens que acompanham esta mensagem.
   *
   * Campo opcional de propósito, e não uma versão nova do contrato: a versão
   * existe para recusar publicação desencontrada entre os dois repositórios, e
   * subi-la obrigaria a ordem certa de deploy. Opcional, o executor pode subir
   * antes e o consumidor depois, sem janela quebrada — quem não manda imagem
   * continua valendo.
   *
   * Se o modelo da conexão não tiver visão, quem recusa é o provedor, e a
   * recusa dele chega inteira a quem pediu.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @MaxLength(8_000_000, { each: true })
  @Matches(DATA_URL_DE_IMAGEM, {
    each: true,
    message: 'cada imagem precisa ser uma URL de dados base64 de png, jpeg, webp ou gif',
  })
  images?: string[];
}

export class GenerationParamsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32000)
  maxTokens?: number;
}

export class GenerationActorDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  userId: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  organizationId?: string;
}

export class GenerationActivationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  activationId: string;

  @IsIn(PROVIDER_KEYS)
  connectionKey: string;

  @IsInt()
  @Min(0)
  connectionRevision: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  model?: string;
}

/**
 * A política de fallback declarada pelo plano de controle.
 *
 * `connectionRevision` e `model` viajam junto com a chave: o fallback aponta
 * para a revisão exata que foi testada e aprovada, e não para "a revisão
 * habilitada mais nova" daquela chave lógica. `ValidateIf` os torna obrigatórios
 * quando a política está ligada, para uma política incompleta ser recusada na
 * validação em vez de resolvida por aproximação depois.
 */
export class GenerationFallbackDto {
  @IsBoolean()
  enabled: boolean;

  @ValidateIf((policy: GenerationFallbackDto) => policy.enabled === true)
  @IsIn(PROVIDER_KEYS)
  connectionKey?: string;

  @ValidateIf((policy: GenerationFallbackDto) => policy.enabled === true)
  @IsInt()
  @Min(0)
  connectionRevision?: number;

  @ValidateIf((policy: GenerationFallbackDto) => policy.enabled === true)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  model?: string;

  @IsArray()
  @ArrayMaxSize(FALLBACK_ELIGIBLE_KINDS.length)
  @IsIn(FALLBACK_ELIGIBLE_KINDS, { each: true })
  allowedCauses: string[];

  @IsInt()
  @Min(1)
  @Max(3)
  maxAttempts: number;
}

export class BrandTokenDto {
  @IsIn(BRAND_TOKEN_KINDS)
  kind: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  value: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  usage?: string;
}

/**
 * Os tokens de marca vigentes de um cliente, estruturados.
 *
 * Estruturados, e não em texto livre: um bloco pronto vindo do consumidor seria
 * prompt privilegiado montado fora daqui, sem validação de tipo, de tamanho nem
 * de dono. O `clientId` viaja junto e precisa bater com o da operação — é o que
 * impede o token de um cliente de compor o contexto de outro.
 */
export class BrandTokenSetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  clientId: string;

  @IsInt()
  @Min(0)
  revision: number;

  @IsIn(BRAND_TOKEN_PROVENANCES)
  provenance: string;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => BrandTokenDto)
  tokens: BrandTokenDto[];
}

/**
 * O pedido de teste de uma conexão provisionada.
 *
 * Só a chave lógica, a revisão e, opcionalmente, o modelo a validar. URL,
 * credencial e protocolo pertencem ao provisionamento deste backend.
 */
export class ConnectionTestDto {
  @IsIn(PROVIDER_KEYS)
  connectionKey: string;

  @IsInt()
  @Min(0)
  revision: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  model?: string;
}

/**
 * A sincronização de uma revisão de conexão reconhecida pelo executor.
 *
 * Não há URL nem segredo aqui, e nem poderia haver: o plano de controle manda a
 * chave lógica, o número da revisão e o modelo, e a configuração executável é a
 * que já está provisionada neste backend.
 */
export class ConnectionRevisionSyncDto {
  @IsIn(PROVIDER_KEYS)
  connectionKey: string;

  @IsInt()
  @Min(0)
  revision: number;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  model: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** A ativação de uma revisão já reconhecida. */
export class ConnectionActivationDto {
  @IsIn(PROVIDER_KEYS)
  connectionKey: string;

  @IsInt()
  @Min(0)
  revision: number;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  activationId: string;
}

/**
 * Os dados do briefing de entregável, para o executor montar o prompt dele.
 *
 * As perguntas obrigatórias e o estado das respostas entram estruturados
 * porque o prompt privilegiado dessa operação é dinâmico: aceitá-lo pronto de
 * quem chama seria aceitar instrução privilegiada vinda de fora.
 */
export class WorkflowBriefingDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deliverableType?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  questions: string[];

  @IsOptional()
  @IsObject()
  existingAnswers?: Record<string, string>;
}

export class BriefingFrameworkDto {
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  objective?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  context?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  target?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  message?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  visual?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  channels?: string;
}

/**
 * O contrato interno de geração, versão 1.
 *
 * O que NÃO existe aqui é parte do contrato: não há URL, não há segredo, não há
 * prompt de sistema e não há nome de conexão livre. A operação vem por nome de
 * uma lista fechada, e o prompt privilegiado dela mora no backend. O
 * `ValidationPipe` global roda com `forbidNonWhitelisted`, então qualquer campo
 * a mais derruba a requisição em vez de ser ignorado em silêncio.
 */
export class GenerateDto {
  @IsInt()
  @IsIn([GENERATION_CONTRACT_VERSION])
  contractVersion: number;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z0-9-]+$/, { message: 'correlationId precisa ser minúsculo, com dígitos e hífen' })
  correlationId: string;

  @IsIn(GENERATION_FEATURES)
  feature: string;

  @ValidateNested()
  @Type(() => GenerationActorDto)
  actor: GenerationActorDto;

  @ValidateNested()
  @Type(() => GenerationActivationDto)
  activation: GenerationActivationDto;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  clientId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'scopePath precisa ser um caminho simples' })
  scopePath?: string;

  @IsOptional()
  @IsBoolean()
  includeDescendants?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  @Matches(SAFE_PATH, { each: true, message: 'excludeScopePaths aceita caminhos simples' })
  excludeScopePaths?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  retrievalQuestion?: string;

  /**
   * O consumidor declara que o acervo deste cliente não pode ser usado agora.
   *
   * É o que uma revogação ainda não liquidada produz do lado do Norman. O
   * gateway trata como indisponibilidade declarada: não consulta nada e avisa o
   * modelo, em vez de gerar com um acervo possivelmente revogado.
   */
  @IsOptional()
  @IsBoolean()
  knowledgeUnavailable?: boolean;

  /**
   * O consumidor declara que a camada geral do sistema não pode ser usada agora.
   *
   * É o que uma revogação do acervo geral ainda não liquidada produz do lado do
   * Norman. A camada geral fica fora da geração e o conhecimento privado do
   * cliente continua valendo — a resposta e o registro dizem, de forma
   * determinística, que faltou a camada geral. Sem esse campo, a única saída
   * seria retirar o acervo inteiro do cliente por causa de uma fonte que não é
   * dele.
   */
  @IsOptional()
  @IsBoolean()
  systemKnowledgeUnavailable?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => BrandTokenSetDto)
  brandTokens?: BrandTokenSetDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowBriefingDto)
  workflowBriefing?: WorkflowBriefingDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BriefingFrameworkDto)
  briefingFramework?: BriefingFrameworkDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => GenerationMessageDto)
  messages: GenerationMessageDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => GenerationParamsDto)
  params?: GenerationParamsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => GenerationFallbackDto)
  fallback?: GenerationFallbackDto;
}
