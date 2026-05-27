import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';

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

    const httpEx = exception instanceof HttpException ? exception : null;
    const response = httpEx?.getResponse();

    const code =
      typeof response === 'object' && response !== null && 'code' in response
        ? (response as Record<string, string>).code
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
        : typeof response === 'object' && response !== null && 'message' in response
          ? String((response as Record<string, unknown>).message)
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
