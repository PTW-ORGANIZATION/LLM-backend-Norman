import { IsOptional, IsString, MaxLength, IsUUID } from 'class-validator';

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class UpdateConversationDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
