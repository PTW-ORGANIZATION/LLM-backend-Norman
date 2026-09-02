import { Module } from '@nestjs/common';
import { OllamaService } from './ollama.service';
import { OllamaVisionService } from './ollama-vision.service';

@Module({
  providers: [OllamaService, OllamaVisionService],
  exports: [OllamaService, OllamaVisionService],
})
export class OllamaModule {}
