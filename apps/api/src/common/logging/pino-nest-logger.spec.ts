import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PinoNestLogger } from './pino-nest-logger';

function fakePino() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
}

describe('PinoNestLogger', () => {
  it('forwards a Nest Logger.warn (with context) to pino.warn', () => {
    const pino = fakePino();
    Logger.overrideLogger(new PinoNestLogger(pino as never));
    try {
      new Logger('DispatchReconciler').warn('stuck ride found');
    } finally {
      Logger.overrideLogger(false);
    }
    expect(pino.warn).toHaveBeenCalledWith({ context: 'DispatchReconciler' }, 'stuck ride found');
  });

  it('maps error with stack and log/debug/verbose levels', () => {
    const pino = fakePino();
    Logger.overrideLogger(new PinoNestLogger(pino as never));
    try {
      const l = new Logger('Outbox');
      l.error('relay failed', 'stack-trace');
      l.log('hi');
      l.debug('dbg');
      l.verbose('vb');
    } finally {
      Logger.overrideLogger(false);
    }
    expect(pino.error).toHaveBeenCalledWith({ context: 'Outbox', stack: 'stack-trace' }, 'relay failed');
    expect(pino.info).toHaveBeenCalledWith({ context: 'Outbox' }, 'hi');
    expect(pino.debug).toHaveBeenCalledWith({ context: 'Outbox' }, 'dbg');
    expect(pino.trace).toHaveBeenCalledWith({ context: 'Outbox' }, 'vb');
  });

  it('spreads object messages as fields', () => {
    const pino = fakePino();
    new PinoNestLogger(pino as never).warn({ message: 'denied', rideId: 'r1' }, 'Gateway');
    expect(pino.warn).toHaveBeenCalledWith({ context: 'Gateway', message: 'denied', rideId: 'r1' }, 'denied');
  });
});
