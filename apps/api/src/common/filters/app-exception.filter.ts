import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { logger } from '../../logger';

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      // main.ts boots Nest with `logger: false`, so Nest's Logger is silent: use pino, or a 5xx leaves no trace
      // in the api logs / Loki (found while recording the M03 Loki scene).
      logger.error(
        { err, method: req.method, route: req.route?.path ?? req.path, request_id: req.headers['x-request-id'] },
        'unhandled exception → 5xx',
      );
    }

    const httpEx = exception instanceof HttpException ? exception : null;
    const response = httpEx?.getResponse();

    const body = typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : null;

    // ValidationPipe throws BadRequestException({ statusCode, message: string[], error }) with no `code`.
    // Only that array shape is treated as validation: it carries field messages and nothing internal.
    const isValidation =
      status === HttpStatus.BAD_REQUEST && body !== null && !('code' in body) && Array.isArray(body.message);

    const code =
      typeof body?.code === 'string'
        ? body.code
        : isValidation
          ? 'validation_error'
          : status === 404
            ? 'not_found'
            : status === 401
              ? 'unauthorized'
              : status === 429
                ? 'rate_limited'
                : 'internal_error';

    const message =
      typeof response === 'string'
        ? response
        : body !== null && 'message' in body
          ? Array.isArray(body.message)
            ? body.message.map(String).join('; ')
            : String(body.message)
          : 'An error occurred';

    res.status(status).json({
      error: {
        code,
        message,
        request_id: req.headers['x-request-id'] ?? '',
      },
    });
  }
}
