import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { RegisterDto, LoginDto } from './auth.dto';

export interface JwtPayload {
  sub: string; // user id
  email: string;
  organizationId: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const user = await this.usersService.create({
      email: dto.email,
      password: dto.password,
      name: dto.name,
    });

    return this.buildAuthResponse(user.id, user.email, user.organizationId, user.name);
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException('E-mail ou senha inválidos.');
    }

    const passwordValid = await this.usersService.validatePassword(user, dto.password);
    if (!passwordValid) {
      throw new UnauthorizedException('E-mail ou senha inválidos.');
    }

    return this.buildAuthResponse(user.id, user.email, user.organizationId, user.name);
  }

  private buildAuthResponse(
    userId: string,
    email: string,
    organizationId: string | null,
    name: string,
  ) {
    const payload: JwtPayload = { sub: userId, email, organizationId };
    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      user: { id: userId, email, name, organizationId },
    };
  }
}
