import type { Logger } from 'pino';

export interface JobOptions {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  logger: Logger;
}

export interface RunningJob {
  /** Schedules no more runs and waits for the current one to finish. */
  stop(): Promise<void>;
}

/**
 * Runs a background job inside the API process (the free host has no separate workers). It runs
 * once straight away, to catch up on work that fell due while the server slept (rule 12), then
 * again `intervalMs` after each run ends, so runs never overlap. A failed run is logged and the
 * next one goes ahead as normal.
 */
export function startJob({ name, intervalMs, run, logger }: JobOptions): RunningJob {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  // async, so a run that throws synchronously still becomes a rejection we catch.
  const attempt = async () => run();

  function tick() {
    current = attempt()
      .catch((err: unknown) => {
        logger.error({ err, job: name }, 'job run failed');
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs).unref();
      });
  }
  tick();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
