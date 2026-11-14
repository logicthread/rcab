import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException, HttpStatus, BadRequestException } from '@nestjs/common';
import { OsrmUnavailableException } from '../../modules/matching/osrm-unavailable.exception';

const errorSpy = vi.hoisted(() => vi.fn());
vi.mock('../../logger', () => ({ logger: { error: errorSpy } }));

import { AppExceptionFilter } from './app-exception.filter';

function host(req: Record<string, unknown>) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return {
    json,
    status,
    host: { switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => req }) } as never,
  };
}

describe('AppExceptionFilter', () => {
  beforeEach(() => errorSpy.mockClear());

  it('logs an unhandled 5xx through pino (Nest logger is disabled in main.ts) and hides the detail from the client', () => {
    const h = host({ method: 'POST', path: '/v1/rides', route: { path: '/v1/rides' }, headers: { 'x-request-id': 'rid-1' } });
    new AppExceptionFilter().catch(new Error('boom'), h.host);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [fields, msg] = errorSpy.mock.calls[0];
    expect(fields).toMatchObject({ method: 'POST', route: '/v1/rides', request_id: 'rid-1' });
    expect(fields.err).toBeInstanceOf(Error);
    expect(msg).toContain('5xx');
    expect(h.status).toHaveBeenCalledWith(500);
    expect(h.json).toHaveBeenCalledWith({ error: { code: 'internal_error', message: 'An error occurred', request_id: 'rid-1' } });
  });

  it('does not log expected 4xx errors', () => {
    const h = host({ method: 'GET', path: '/x', headers: {} });
    new AppExceptionFilter().catch(new HttpException({ code: 'bad', message: 'nope' }, HttpStatus.BAD_REQUEST), h.host);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(h.status).toHaveBeenCalledWith(400);
  });

  it('maps ValidationPipe 400s to validation_error with the field messages', () => {
    const h = host({ method: 'POST', path: '/v1/vehicles', headers: { 'x-request-id': 'r' } });
    new AppExceptionFilter().catch(
      new BadRequestException({ statusCode: 400, message: ['seats must be a number', 'reg_no should not be empty'], error: 'Bad Request' }),
      h.host,
    );
    expect(h.status).toHaveBeenCalledWith(400);
    expect(h.json).toHaveBeenCalledWith({
      error: { code: 'validation_error', message: 'seats must be a number; reg_no should not be empty', request_id: 'r' },
    });
  });

  it('keeps an explicit code on a 400', () => {
    const h = host({ method: 'POST', path: '/x', headers: {} });
    new AppExceptionFilter().catch(new BadRequestException({ code: 'no_vehicle_selected', message: 'pick one' }), h.host);
    expect(h.json.mock.calls[0][0].error.code).toBe('no_vehicle_selected');
  });

  it('reports OSRM outage as 503 routing_unavailable', () => {
    const h = host({ method: 'POST', path: '/v1/rides/quote', headers: {} });
    new AppExceptionFilter().catch(new OsrmUnavailableException(), h.host);
    expect(h.status).toHaveBeenCalledWith(503);
    expect(h.json.mock.calls[0][0].error.code).toBe('routing_unavailable');
  });
});
