import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json } from 'express';
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

  // O padrão do Express é 100 KB, e a leitura de texto em arte manda a imagem
  // no corpo: uma peça de 275 KB vira ~366 KB em base64 e era recusada antes
  // de chegar ao controller. Quem chamava caía no leitor reserva sem saber por
  // quê, e a tela mostrava o resultado do reserva como se fosse do modelo de
  // visão. O teto aqui acompanha o que o DTO da rota já limita por imagem.
  app.use(json({ limit: '16mb' }));

  // CORS liberado para o frontend React consumir a API.
  // Em produção, troque origin: true por a URL exata do seu frontend.
  app.enableCors({ origin: true, credentials: true });

  const port = config.get<number>('port') ?? 3000;
  const host = config.get<string>('host') ?? '0.0.0.0';
  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`Backend rodando em http://${host}:${port}`);
}

bootstrap();
