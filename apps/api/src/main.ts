import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { logger } from './logger';

const PORT = Number(process.env.PORT ?? 3000);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, logger: false });
  await app.listen(PORT);
  logger.info({ port: PORT }, 'http server listening');
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'bootstrap failed');
  process.exit(1);
});
