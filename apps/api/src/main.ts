import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { logger } from './logger';
import { PinoNestLogger } from './common/logging/pino-nest-logger';
import { resolveBrowserOrigins } from './common/guards/auth-config';
import { envNumber } from './common/utils/env';

const PORT = envNumber('PORT', 3000, { integer: true, min: 1, max: 65535 });

async function bootstrap(): Promise<void> {
  // Validated before anything starts: outside development/test a missing,
  // wildcard or non-https origin list aborts startup (F11). Same list as CsrfGuard.
  const corsOrigins = resolveBrowserOrigins();

  const app = await NestFactory.create(AppModule, { bufferLogs: true, logger: false });
  // `logger: false` alone drops every Nest Logger line; forward them to pino (stdout -> Loki).
  app.useLogger(new PinoNestLogger());
  app.use(cookieParser());

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
