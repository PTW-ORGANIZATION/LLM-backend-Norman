import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'E-mail inválido.' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'A senha deve ter no mínimo 8 caracteres.' })
  @MaxLength(72, { message: 'A senha deve ter no máximo 72 caracteres.' }) // limite do bcrypt
  password: string;

  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name: string;
}

export class LoginDto {
  @IsEmail({}, { message: 'E-mail inválido.' })
  email: string;

  @IsString()
  password: string;
}
