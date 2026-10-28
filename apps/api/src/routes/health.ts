import { Router } from 'express';

export type CheckDb = () => Promise<unknown>;

export function healthRouter(checkDb: CheckDb): Router {
  const router = Router();

  // The process is up. No dependencies, so the container healthcheck never flaps on DB blips.
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // The process can serve traffic: the database answers.
  router.get('/ready', async (req, res) => {
    try {
      await checkDb();
      res.json({ status: 'ready' });
    } catch (err) {
      req.log.warn({ err }, 'readiness check failed');
      res.status(503).json({ status: 'unavailable' });
    }
  });

  return router;
}
