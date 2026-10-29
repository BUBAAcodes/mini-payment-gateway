import { prisma } from '@gateway/db';
import { createApp } from './app';
import { loadConfig } from './config';
import { createLogger } from './logger';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

const app = createApp({
  logger,
  db: prisma,
  config,
  checkDb: () => prisma.$queryRaw`SELECT 1`,
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'api listening');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // Don't hang forever on keep-alive connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
