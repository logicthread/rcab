import pino from 'pino';

const level =
  process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export const logger = pino({
  level,
  base: { service: 'api' },
  // Defence in depth: never emit credentials if an object carrying them is logged.
  redact: {
    paths: [
      'password',
      'token',
      'accessToken',
      'refreshToken',
      'secret',
      '*.password',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.secret',
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers.cookie',
    ],
    censor: '[redacted]',
  },
});
