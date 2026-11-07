import { describe, expect, it } from 'vitest';
import { Constraint, pgConstraintViolation } from './constraints';

describe('pgConstraintViolation', () => {
  it('reads code + constraint off a pg DatabaseError shape', () => {
    expect(
      pgConstraintViolation({ code: '23505', constraint: Constraint.AssignmentDriverBusy }),
    ).toEqual({ code: '23505', constraint: 'driver_active_assignment_pkey' });
  });

  it('unwraps a driver error carried as `cause`', () => {
    const wrapped = new Error('Failed query', {
      cause: { code: '23514', constraint: Constraint.PoolCapacity },
    });
    expect(pgConstraintViolation(wrapped)).toEqual({
      code: '23514',
      constraint: 'shared_rides_seat_capacity_check',
    });
  });

  it('returns null for anything without a constraint', () => {
    expect(pgConstraintViolation(new Error('boom'))).toBeNull();
    expect(pgConstraintViolation({ code: '40P01' })).toBeNull();
    expect(pgConstraintViolation(null)).toBeNull();
    expect(pgConstraintViolation('23505')).toBeNull();
  });
});
