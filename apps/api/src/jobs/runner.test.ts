import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger';
import { startJob, type RunningJob } from './runner';

const INTERVAL = 1000;

let job: RunningJob | undefined;
const logger = createLogger('silent');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await job?.stop();
  job = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startJob', () => {
  it('runs once at startup to catch up, then every interval', async () => {
    const run = vi.fn(async () => {});
    job = startJob({ name: 'test', intervalMs: INTERVAL, run, logger });

    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('never starts a run while the last one is still going', async () => {
    let finish = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    job = startJob({ name: 'test', intervalMs: INTERVAL, run, logger });

    await vi.advanceTimersByTimeAsync(INTERVAL * 10);
    expect(run).toHaveBeenCalledTimes(1);

    // The next run waits a full interval after the slow one ends.
    finish();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(run).toHaveBeenCalledTimes(2);
    finish(); // Ends the second run, so stop() in afterEach can return.
  });

  it('logs a failed run and keeps going', async () => {
    const error = vi.spyOn(logger, 'error');
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue();
    job = startJob({ name: 'test', intervalMs: INTERVAL, run, logger });

    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'test', err: expect.any(Error) }),
      'job run failed',
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stop() waits for the current run and schedules no more', async () => {
    let finish = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    job = startJob({ name: 'test', intervalMs: INTERVAL, run, logger });

    let stopped = false;
    const stopping = job.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
