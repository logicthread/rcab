import { Queue } from 'bullmq';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ScheduledDispatchService,
  SCHEDULED_DISPATCH_QUEUE,
  SCHEDULED_WAKE_JOB,
  wakeJobId,
} from '../../src/modules/scheduled/scheduled.service';
import { buildPolicy, defaultPolicy } from '../../src/config/policy/policy';

const SCHEDULED_WAKE_LEAD_MS = defaultPolicy().scheduled.wakeLeadMs;

const skip = process.env.RCAB_INT_SKIPPED === '1';

function parseRedis(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

describe.skipIf(skip)('ScheduledDispatchService — wake queue (real Redis + BullMQ)', () => {
  let queue: Queue;
  let service: ScheduledDispatchService;

  beforeAll(() => {
    const conn = parseRedis(process.env.TEST_REDIS_URL!);
    queue = new Queue(SCHEDULED_DISPATCH_QUEUE, { connection: conn });
    const config = { get: vi.fn().mockReturnValue(undefined) };
    service = new ScheduledDispatchService(queue as never, buildPolicy(config));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
  });

  it('scheduleWake enqueues a delayed job that fires lead-time before scheduled_for', async () => {
    const rideId = randomUUID();
    const scheduledFor = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h out

    const { jobId, delayMs } = await service.scheduleWake(rideId, scheduledFor, 1);

    expect(jobId).toBe(wakeJobId(rideId, 1));
    expect(jobId).toBe(`scheduled-wake-${rideId}-g1`);
    // ~ (2h − 10min lead); allow a few seconds of clock slack.
    const expected = 2 * 60 * 60 * 1000 - SCHEDULED_WAKE_LEAD_MS;
    expect(Math.abs(delayMs - expected)).toBeLessThan(5000);

    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(SCHEDULED_WAKE_JOB);
    expect(job!.data).toEqual({ rideId, generation: 1 });
    expect(Math.abs((job!.delay ?? 0) - delayMs)).toBeLessThan(50);

    await service.cancelWake(rideId);
  });

  it('clamps delay to 0 when the wake time is already in the past', async () => {
    const rideId = randomUUID();
    const scheduledFor = new Date(Date.now() + 60_000); // 1min out → wake (−10min) is in the past

    const { delayMs } = await service.scheduleWake(rideId, scheduledFor);
    expect(delayMs).toBe(0);

    await service.cancelWake(rideId);
  });

  it('publishing the same ride+generation twice yields one job (republish is a no-op)', async () => {
    const rideId = randomUUID();
    await service.scheduleWake(rideId, new Date(Date.now() + 3 * 60 * 60 * 1000));
    await service.scheduleWake(rideId, new Date(Date.now() + 3 * 60 * 60 * 1000));

    const job = await queue.getJob(wakeJobId(rideId));
    expect(job).toBeDefined();
    const all = await queue.getDelayed();
    expect(all.filter((j) => j.data.rideId === rideId)).toHaveLength(1);

    await service.cancelWake(rideId);
  });

  it('cancelWake removes a pending job and reports whether one existed', async () => {
    const rideId = randomUUID();
    await service.scheduleWake(rideId, new Date(Date.now() + 2 * 60 * 60 * 1000));

    expect(await service.cancelWake(rideId)).toBe(true);
    expect(await queue.getJob(wakeJobId(rideId))).toBeUndefined();
    // Second cancel: nothing left to remove.
    expect(await service.cancelWake(rideId)).toBe(false);
  });

  it('cancelWake also removes a legacy colon-id wake that was in flight at deploy', async () => {
    const rideId = randomUUID();
    await queue.add(
      SCHEDULED_WAKE_JOB,
      { rideId },
      { jobId: `scheduled:wake:${rideId}`, delay: 60 * 60 * 1000 },
    );
    expect(await service.cancelWake(rideId)).toBe(true);
    expect(await queue.getJob(`scheduled:wake:${rideId}`)).toBeUndefined();
  });
});
