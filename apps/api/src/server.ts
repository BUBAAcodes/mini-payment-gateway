import { prisma } from '@gateway/db';
import { createApp } from './app';
import { loadConfig } from './config';
import { createFakeBank } from './fake-bank';
import { checkPendingPayments, STATUS_CHECK_INTERVAL_MS } from './jobs/payment-status-checks';
import { startJob } from './jobs/runner';
import { fanOutAllEvents } from './jobs/webhook-fan-out';
import { WEBHOOK_POLL_INTERVAL_MS, sendDueWebhooks } from './jobs/webhook-sender';
import { createLogger } from './logger';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const bank = createFakeBank(prisma, { slowDelayMs: config.BANK_SLOW_MS });

const app = createApp({
  logger,
  db: prisma,
  bank,
  config,
  checkDb: () => prisma.$queryRaw`SELECT 1`,
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'api listening');
});

// Background jobs run inside the API process: the free host has no separate workers (section 18).
const paymentDeps = {
  db: prisma,
  bank,
  feeBps: config.FEE_BPS,
  bankTimeoutMs: config.BANK_TIMEOUT_MS,
};
const jobs = [
  startJob({
    name: 'payment-status-checks',
    intervalMs: STATUS_CHECK_INTERVAL_MS,
    logger,
    run: async () => {
      // Payments younger than BANK_TIMEOUT_MS may still have a pay request waiting on the bank.
      await checkPendingPayments(paymentDeps, logger.child({ job: 'payment-status-checks' }), {
        minAgeMs: config.BANK_TIMEOUT_MS,
      });
    },
  }),
  startJob({
    name: 'webhook-fan-out',
    intervalMs: WEBHOOK_POLL_INTERVAL_MS,
    logger,
    run: async () => {
      await fanOutAllEvents(prisma, logger.child({ job: 'webhook-fan-out' }));
    },
  }),
  startJob({
    name: 'webhook-sender',
    intervalMs: WEBHOOK_POLL_INTERVAL_MS,
    logger,
    run: async () => {
      await sendDueWebhooks(prisma, logger.child({ job: 'webhook-sender' }), {
        encryptionKey: config.APP_ENCRYPTION_KEY,
        allowPrivate: config.ALLOW_PRIVATE_WEBHOOK_URLS,
      });
    },
  }),
];

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await Promise.all(jobs.map((job) => job.stop()));
    await prisma.$disconnect();
    process.exit(0);
  });
  // Don't hang forever on keep-alive connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
