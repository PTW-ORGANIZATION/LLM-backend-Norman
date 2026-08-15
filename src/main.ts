import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // Rejeita automaticamente qualquer campo não esperado no corpo da requisição
  // e valida os DTOs (RegisterDto, LoginDto, etc.) antes de chegar no controller.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS liberado para o frontend React consumir a API.
  // Em produção, troque origin: true por a URL exata do seu frontend.
  app.enableCors({ origin: true, credentials: true });

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Backend rodando em http://127.0.0.1:${port}`);
}

bootstrap();
