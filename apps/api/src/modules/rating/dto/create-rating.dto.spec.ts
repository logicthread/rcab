import { describe, it, expect } from 'vitest';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateRatingDto } from './create-rating.dto';

function violations(body: unknown): string[] {
  const dto = plainToInstance(CreateRatingDto, body);
  return validateSync(dto).flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe('CreateRatingDto', () => {
  it('accepts integer stars 1..5 with optional text', () => {
    expect(violations({ stars: 5, text: 'smooth ride' })).toHaveLength(0);
    expect(violations({ stars: 1 })).toHaveLength(0);
    expect(violations({ stars: 3 })).toHaveLength(0);
  });

  it('rejects stars below 1 or above 5', () => {
    expect(violations({ stars: 0 }).length).toBeGreaterThan(0);
    expect(violations({ stars: 6 }).length).toBeGreaterThan(0);
  });

  it('rejects non-integer or missing stars', () => {
    expect(violations({ stars: 3.5 }).length).toBeGreaterThan(0);
    expect(violations({}).length).toBeGreaterThan(0);
  });

  it('rejects over-long text', () => {
    expect(violations({ stars: 5, text: 'x'.repeat(1001) }).length).toBeGreaterThan(0);
  });
});
