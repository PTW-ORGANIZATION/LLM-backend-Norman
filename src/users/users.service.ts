import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './user.entity';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async create(params: {
    email: string;
    password: string;
    name: string;
    organizationId?: string | null;
  }): Promise<User> {
    const existing = await this.findByEmail(params.email);
    if (existing) {
      throw new ConflictException('Já existe um usuário com este e-mail.');
    }

    const passwordHash = await bcrypt.hash(params.password, BCRYPT_ROUNDS);

    const user = this.usersRepository.create({
      email: params.email,
      passwordHash,
      name: params.name,
      organizationId: params.organizationId ?? null,
    });

    return this.usersRepository.save(user);
  }

  async validatePassword(user: User, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.passwordHash);
  }
}
