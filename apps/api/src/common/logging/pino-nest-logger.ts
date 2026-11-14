import type { LoggerService } from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';
import { logger as defaultLogger } from '../../logger';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Forwards Nest's `Logger` calls to the shared pino logger. main.ts boots Nest
 * with `logger: false`, which silently dropped every `new Logger(X).warn(...)`;
 * registering this via `app.useLogger` puts them on stdout (and into Loki).
 *
 * Nest passes the context as the LAST string argument, and for `error()` an
 * optional stack string before it. Most call sites use the pino shape
 * `log.warn({ ...fields }, 'message')`; Nest hands that over as
 * (fields, 'message', context), so a leading string after an object message is
 * the message text, unless it is a stack trace on `error()`/`fatal()`.
 */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly pino: PinoLogger = defaultLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params, true);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params, true);
  }

  private write(level: Level, message: unknown, params: unknown[], withStack = false): void {
    let context: string | undefined;
    const rest = [...params];
    if (rest.length > 0 && typeof rest[rest.length - 1] === 'string') {
      context = rest.pop() as string;
    }
    const fields: Record<string, unknown> = {};
    if (context) fields.context = context;
    const objectMessage = typeof message === 'object' && message !== null && !(message instanceof Error);
    let text: string | undefined;
    if (rest.length > 0 && typeof rest[0] === 'string') {
      const first = rest[0] as string;
      if (withStack && (!objectMessage || isStack(first))) fields.stack = rest.shift();
      else if (objectMessage) text = rest.shift() as string;
    }

    let msg: string;
    if (message instanceof Error) {
      fields.err = message;
      msg = message.message;
    } else if (typeof message === 'object' && message !== null) {
      Object.assign(fields, message);
      const m = (message as { message?: unknown }).message;
      msg = text ?? (typeof m === 'string' ? m : '');
    } else {
      msg = String(message);
    }
    this.pino[level](fields, msg);
  }
}

function isStack(s: string): boolean {
  return /\n\s+at /.test(s);
}
