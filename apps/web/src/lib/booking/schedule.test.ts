import { describe, it, expect } from 'vitest';
import {
  defaultScheduleTime,
  formatScheduled,
  fromLocalInputValue,
  isBeforeWake,
  scheduleBounds,
  toLocalInputValue,
  validateSchedule,
} from './schedule';

const NOW = new Date('2026-11-10T08:02:00.000Z');
const min = (n: number) => n * 60_000;

describe('schedule helpers', () => {
  it('bounds: min = 15 min + 1 min slack, max = 24 h', () => {
    const { min: lo, max: hi } = scheduleBounds(NOW);
    expect(lo.getTime() - NOW.getTime()).toBe(min(16));
    expect(hi.getTime() - NOW.getTime()).toBe(24 * 60 * min(1));
  });

  it('default time is >= 30 min out and on a 5-minute boundary', () => {
    const d = defaultScheduleTime(NOW);
    expect(d.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(min(30));
    expect(d.getTime() - NOW.getTime()).toBeLessThan(min(35));
    expect(d.getTime() % min(5)).toBe(0);
  });

  it('round-trips a local datetime-local value through an ISO instant', () => {
    const d = new Date(2026, 10, 10, 15, 30);
    const v = toLocalInputValue(d);
    expect(v).toBe('2026-11-10T15:30');
    expect(fromLocalInputValue(v)).toBe(d.toISOString());
    expect(fromLocalInputValue('')).toBeNull();
    expect(fromLocalInputValue('not a date')).toBeNull();
  });

  it('validateSchedule accepts the 15 min - 24 h window and rejects outside / missing', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(validateSchedule(at(min(30)), NOW)).toBeNull();
    expect(validateSchedule(at(min(15)), NOW)).toBeNull();
    expect(validateSchedule(at(min(10)), NOW)).toMatch(/between 15 minutes and 24 hours/);
    expect(validateSchedule(at(25 * 60 * min(1)), NOW)).toMatch(/between 15 minutes and 24 hours/);
    expect(validateSchedule(null, NOW)).toMatch(/Pick a time/);
    expect(validateSchedule('garbage', NOW)).toMatch(/Pick a time/);
  });

  it('isBeforeWake is true until T-10 min, false after, and false without a time', () => {
    const pickup = new Date(NOW.getTime() + min(60)).toISOString();
    expect(isBeforeWake(pickup, NOW)).toBe(true);
    expect(isBeforeWake(pickup, new Date(NOW.getTime() + min(49)))).toBe(true);
    expect(isBeforeWake(pickup, new Date(NOW.getTime() + min(51)))).toBe(false);
    expect(isBeforeWake(null, NOW)).toBe(false);
    expect(isBeforeWake('garbage', NOW)).toBe(false);
  });

  it('formatScheduled falls back to the raw string for garbage', () => {
    expect(formatScheduled('garbage')).toBe('garbage');
    expect(formatScheduled(NOW.toISOString())).toMatch(/\d/);
  });
});
