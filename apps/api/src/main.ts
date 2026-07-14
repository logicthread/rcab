import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { logger } from './logger';

const PORT = Number(process.env.PORT ?? 3000);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, logger: false });
  app.use(cookieParser());

  const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3002,http://localhost:3001')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  if (process.env.NODE_ENV !== 'production') {
    logger.warn(`NODE_ENV=${process.env.NODE_ENV ?? 'unset'}: refresh-token cookie will be set WITHOUT Secure flag`);
  }

  await app.listen(PORT);
  logger.info({ port: PORT, corsOrigins }, 'http server listening');
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'bootstrap failed');
  process.exit(1);
});
