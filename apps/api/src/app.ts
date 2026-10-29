import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { PrismaClient } from '@gateway/db';
import { createLogger } from './logger';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { assignRequestId } from './middleware/request-id';
import { healthRouter, type CheckDb } from './routes/health';
import { merchantRouter } from './routes/merchant';

export interface AppDeps {
  db: PrismaClient;
  checkDb: CheckDb;
  logger?: Logger;
  /** Mounts more routes before the 404 handler. Tests use it to exercise middleware. */
  extraRoutes?: (router: Router) => void;
}

// Tests get a silent logger unless they pass their own.
const defaultLogger = () => createLogger(process.env.NODE_ENV === 'test' ? 'silent' : 'info');

export function createApp({
  db,
  checkDb,
  logger = defaultLogger(),
  extraRoutes,
}: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(pinoHttp({ logger, genReqId: assignRequestId }));
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter(checkDb));
  app.use('/v1', merchantRouter(db));
  if (extraRoutes) {
    const router = Router();
    extraRoutes(router);
    app.use(router);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
