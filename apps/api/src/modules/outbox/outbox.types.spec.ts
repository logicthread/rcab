import { describe, expect, it } from 'vitest';
import { OutboxTopic, outboxDedupeKey } from './outbox.types';

describe('outboxDedupeKey', () => {
  it('is one key per (topic, aggregate, generation)', () => {
    const id = '7d1f3c1e-6f9a-4c55-9d43-0b1c2f3a4b5c';
    expect(outboxDedupeKey(OutboxTopic.RideWakeSchedule, id, 1)).toBe(
      `ride.wake.schedule:${id}:g1`,
    );
    expect(outboxDedupeKey(OutboxTopic.RideDispatchRequested, id, 2)).not.toBe(
      outboxDedupeKey(OutboxTopic.RideDispatchRequested, id, 1),
    );
  });

  it('every registered topic satisfies the DB topic format check', () => {
    for (const topic of Object.values(OutboxTopic)) {
      expect(topic).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    }
  });
});
