import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import {
  NotFoundError,
  listReconciliationIssuesSchema,
  paginationSchema,
  type CreatedApiKeyResponse,
  type ListReconciliationIssuesInput,
  type MerchantResponse,
} from '@gateway/shared';
import type { z } from 'zod';
import type { AppConfig } from '../../config';
import type { BankClient } from '../../fake-bank';
import { merchantIdOf, requireDashboardService } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { apiKeyResource, createApiKey, listApiKeys, revokeApiKey } from '../../services/api-keys';
import { getDashboardOverview } from '../../services/overview';
import {
  listReconciliationIssues,
  reconciliationIssueResource,
  resolveReconciliationIssue,
} from '../../services/reconciliation';
import { balanceRouter } from '../merchant/balance';
import { eventsRouter } from '../merchant/events';
import { paymentsRouter } from '../merchant/payments';
import { refundsRouter } from '../merchant/refunds';
import { settlementsRouter } from '../merchant/settlements';
import { webhookEndpointsRouter } from '../merchant/webhook-endpoints';

export interface DashboardRouterDeps {
  db: PrismaClient;
  /** Refunds go to the bank. */
  bank: BankClient;
  config: AppConfig;
}

/**
 * The dashboard API under /dashboard, called only by the web app's server with
 * DASHBOARD_SERVICE_TOKEN and the logged-in merchant's ID. It mounts the merchant API's own
 * routers, so the dashboard and /v1 share every service and every merchant_id filter. Orders stay
 * out (merchants' servers create those), and there is no rate limit: that one is per API key.
 * Not in the public API docs.
 */
export function dashboardRouter({ db, bank, config }: DashboardRouterDeps): Router {
  const router = Router();
  router.use(requireDashboardService(db, config.DASHBOARD_SERVICE_TOKEN));

  router.use(paymentsRouter(db));
  router.use(refundsRouter(db, bank, config));
  router.use(webhookEndpointsRouter(db, config));
  router.use(eventsRouter(db, config));
  router.use(settlementsRouter(db));
  router.use(balanceRouter(db));

  router.get('/merchant', async (_req, res) => {
    const merchant = await db.merchant.findUnique({ where: { id: merchantIdOf(res) } });
    // The auth middleware has just checked it exists; this only guards a delete in between.
    if (!merchant) throw new NotFoundError('Merchant');
    const body: MerchantResponse = {
      id: merchant.id,
      name: merchant.name,
      created_at: merchant.createdAt.toISOString(),
    };
    res.json(body);
  });

  router.get('/overview', async (_req, res) => {
    res.json(await getDashboardOverview(db, merchantIdOf(res)));
  });

  router.get('/api_keys', validate({ query: paginationSchema }), async (_req, res) => {
    const query = res.locals.validated.query as z.infer<typeof paginationSchema>;
    const page = await listApiKeys(db, merchantIdOf(res), {
      limit: query.limit,
      startingAfter: query.starting_after,
    });
    res.json({ data: page.data.map(apiKeyResource), has_more: page.has_more });
  });

  // The full key appears in this response only. No idempotency: a retry makes a second key, which
  // the merchant can see in the list and revoke.
  router.post('/api_keys', async (_req, res) => {
    const created = await createApiKey(db, merchantIdOf(res));
    const body: CreatedApiKeyResponse = { ...apiKeyResource(created.row), key: created.key };
    res.status(201).json(body);
  });

  router.post('/api_keys/:id/revoke', async (req, res) => {
    const key = await revokeApiKey(db, merchantIdOf(res), req.params.id);
    res.json(apiKeyResource(key));
  });

  router.get(
    '/reconciliation_issues',
    validate({ query: listReconciliationIssuesSchema }),
    async (_req, res) => {
      const query = res.locals.validated.query as ListReconciliationIssuesInput;
      const page = await listReconciliationIssues(db, merchantIdOf(res), query);
      res.json({ data: page.data.map(reconciliationIssueResource), has_more: page.has_more });
    },
  );

  router.post('/reconciliation_issues/:id/resolve', async (req, res) => {
    const issue = await resolveReconciliationIssue(db, merchantIdOf(res), req.params.id);
    res.json(reconciliationIssueResource(issue));
  });

  return router;
}
