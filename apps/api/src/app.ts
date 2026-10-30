import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { PrismaClient } from '@gateway/db';
import type { AppConfig } from './config';
import type { BankClient } from './fake-bank';
import { createLogger, redactCheckoutSecret } from './logger';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { assignRequestId } from './middleware/request-id';
import { checkoutRouter } from './routes/checkout';
import { healthRouter, type CheckDb } from './routes/health';
import { merchantRouter } from './routes/merchant';

export interface AppDeps {
  db: PrismaClient;
  bank: BankClient;
  checkDb: CheckDb;
  config: AppConfig;
  logger?: Logger;
  /** Mounts more routes before the 404 handler. Tests use it to exercise middleware. */
  extraRoutes?: (router: Router) => void;
}

// Tests get a silent logger unless they pass their own.
const defaultLogger = () => createLogger(process.env.NODE_ENV === 'test' ? 'silent' : 'info');

export function createApp({
  db,
  bank,
  checkDb,
  config,
  logger = defaultLogger(),
  extraRoutes,
}: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    pinoHttp({ logger, genReqId: assignRequestId, serializers: { req: redactCheckoutSecret } }),
  );
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter(checkDb));
  app.use('/v1', merchantRouter(db, config));
  app.use(
    '/checkout',
    checkoutRouter({
      db,
      bank,
      feeBps: config.FEE_BPS,
      bankTimeoutMs: config.BANK_TIMEOUT_MS,
      encryptionKey: config.APP_ENCRYPTION_KEY,
    }),
  );
  if (extraRoutes) {
    const router = Router();
    extraRoutes(router);
    app.use(router);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
