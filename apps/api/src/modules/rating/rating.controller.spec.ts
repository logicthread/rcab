import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { RatingController } from './rating.controller';
import type { JwtPayload } from '../../common/guards/auth.guard';
import type { RatingRow } from './rating.repository';
import type { RateResult } from './rating.service';

const RIDE_ID = 'ride-1';

function reqAs(role: 'client' | 'driver', sub = 'u-1'): Request & { user: JwtPayload } {
  return { user: { sub, role } as JwtPayload } as Request & { user: JwtPayload };
}

function okResult(): RateResult {
  const rating: RatingRow = {
    id: 'rating-1',
    rideId: RIDE_ID,
    raterId: 'u-1',
    subjectId: 'd-1',
    stars: 5,
    text: null,
    createdAt: new Date(),
  };
  return { ok: true, rating };
}

describe('RatingController.rate', () => {
  let service: { rate: ReturnType<typeof vi.fn> };
  let ctrl: RatingController;

  beforeEach(() => {
    service = { rate: vi.fn() };
    ctrl = new RatingController(service as never);
  });

  it('returns the {id,rideId,subjectId,stars} body on success', async () => {
    service.rate.mockResolvedValue(okResult());

    const res = await ctrl.rate(reqAs('client'), RIDE_ID, { stars: 5, text: 'nice' });

    expect(res).toEqual({ id: 'rating-1', rideId: RIDE_ID, subjectId: 'd-1', stars: 5 });
    expect(service.rate).toHaveBeenCalledWith(
      expect.objectContaining({ rideId: RIDE_ID, raterId: 'u-1', stars: 5, text: 'nice' }),
    );
  });

  it('passes null text through when omitted', async () => {
    service.rate.mockResolvedValue(okResult());

    await ctrl.rate(reqAs('driver'), RIDE_ID, { stars: 4 });

    expect(service.rate).toHaveBeenCalledWith(expect.objectContaining({ text: null }));
  });

  it('maps not_found → 404', async () => {
    service.rate.mockResolvedValue({ ok: false, reason: 'not_found' });
    await expect(ctrl.rate(reqAs('client'), RIDE_ID, { stars: 5 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps not_a_party → 403', async () => {
    service.rate.mockResolvedValue({ ok: false, reason: 'not_a_party' });
    await expect(ctrl.rate(reqAs('client'), RIDE_ID, { stars: 5 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('maps not_completed → 409', async () => {
    service.rate.mockResolvedValue({ ok: false, reason: 'not_completed' });
    await expect(ctrl.rate(reqAs('client'), RIDE_ID, { stars: 5 })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('maps already_rated → 409', async () => {
    service.rate.mockResolvedValue({ ok: false, reason: 'already_rated' });
    await expect(ctrl.rate(reqAs('client'), RIDE_ID, { stars: 5 })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
