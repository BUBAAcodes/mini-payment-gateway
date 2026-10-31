import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real modules only work inside a Next.js request.
vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ connection: async () => {} }));

const api = await import('./dashboard-api');
const { callDashboardApi, getBalance } = api;

const TOKEN = 't'.repeat(64);
const MERCHANT = 'mer_8fK2mQx9LpZ3aB';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('DASHBOARD_SERVICE_TOKEN', TOKEN);
  vi.stubEnv('API_BASE_URL', 'http://api.test');
  fetchMock = vi.fn(async () => Response.json({ balance: 49_000, currency: 'INR' }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function sent() {
  const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  return { url: url.toString(), init, headers: new Headers(init.headers) };
}

describe('callDashboardApi', () => {
  it('sends the service token and the merchant ID from the session', async () => {
    const result = await getBalance(MERCHANT);

    expect(result).toEqual({ ok: true, data: { balance: 49_000, currency: 'INR' } });
    const { url, init, headers } = sent();
    expect(url).toBe('http://api.test/dashboard/balance');
    expect(init.method).toBe('GET');
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('x-merchant-id')).toBe(MERCHANT);
    expect(headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.has('idempotency-key')).toBe(false);
  });

  it('sends a JSON body and an Idempotency-Key when given one', async () => {
    await callDashboardApi(MERCHANT, '/dashboard/payments/pay_x/refunds', {
      method: 'POST',
      body: { amount: 100 },
      idempotencyKey: 'key-1',
    });

    const { init, headers } = sent();
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"amount":100}');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('idempotency-key')).toBe('key-1');
  });

  it("passes the API's error through", async () => {
    const error = { code: 'not_found', message: 'Payment not found' };
    fetchMock.mockResolvedValueOnce(Response.json({ error }, { status: 404 }));

    expect(await getBalance(MERCHANT)).toEqual({ ok: false, error });
  });

  it('reports the API being down as unavailable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await getBalance(MERCHANT);
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  it('refuses to call the API without a service token', async () => {
    vi.stubEnv('DASHBOARD_SERVICE_TOKEN', '');
    await expect(getBalance(MERCHANT)).rejects.toThrow(/DASHBOARD_SERVICE_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('dashboard API calls', () => {
  type Call = [
    name: string,
    run: () => Promise<unknown>,
    method: string,
    path: string,
    body?: unknown,
  ];

  const calls: Call[] = [
    ['getOverview', () => api.getOverview(MERCHANT), 'GET', '/dashboard/overview'],
    ['getPayment', () => api.getPayment(MERCHANT, 'pay_1'), 'GET', '/dashboard/payments/pay_1'],
    ['listApiKeys', () => api.listApiKeys(MERCHANT), 'GET', '/dashboard/api_keys?limit=100'],
    ['createApiKey', () => api.createApiKey(MERCHANT), 'POST', '/dashboard/api_keys'],
    [
      'revokeApiKey',
      () => api.revokeApiKey(MERCHANT, 'key_1'),
      'POST',
      '/dashboard/api_keys/key_1/revoke',
    ],
    [
      'listWebhookEndpoints',
      () => api.listWebhookEndpoints(MERCHANT),
      'GET',
      '/dashboard/webhook_endpoints?limit=100',
    ],
    [
      'deleteWebhookEndpoint',
      () => api.deleteWebhookEndpoint(MERCHANT, 'we_1'),
      'DELETE',
      '/dashboard/webhook_endpoints/we_1',
    ],
    [
      'testWebhookEndpoint',
      () => api.testWebhookEndpoint(MERCHANT, 'we_1'),
      'POST',
      '/dashboard/webhook_endpoints/we_1/test',
    ],
    ['listEvents', () => api.listEvents(MERCHANT, {}), 'GET', '/dashboard/events?limit=20'],
    [
      'listSettlements',
      () => api.listSettlements(MERCHANT, { starting_after: 'stl_9' }),
      'GET',
      '/dashboard/settlements?limit=20&starting_after=stl_9',
    ],
    [
      'listReconciliationIssues',
      () => api.listReconciliationIssues(MERCHANT, { status: 'open' }),
      'GET',
      '/dashboard/reconciliation_issues?limit=20&status=open',
    ],
    [
      'resolveReconciliationIssue',
      () => api.resolveReconciliationIssue(MERCHANT, 'ri_1'),
      'POST',
      '/dashboard/reconciliation_issues/ri_1/resolve',
    ],
  ];

  it.each(calls)(
    '%s calls its route for the session merchant',
    async (_name, run, method, path) => {
      await run();
      const { url, init, headers } = sent();
      expect(init.method).toBe(method);
      expect(url).toBe(`http://api.test${path}`);
      expect(headers.get('x-merchant-id')).toBe(MERCHANT);
    },
  );

  it("gets a payment's refunds and events", async () => {
    await api.getPaymentActivity(MERCHANT, 'pay_1');
    expect(sent().url).toBe('http://api.test/dashboard/payments/pay_1/activity');
  });

  it('lists events by type and delivery status, leaving out unset filters', async () => {
    await api.listEvents(MERCHANT, { type: 'payment.captured', delivery_status: 'failed' });
    expect(sent().url).toBe(
      'http://api.test/dashboard/events?limit=20&type=payment.captured&delivery_status=failed',
    );
  });

  it('lists payments with only the filters that are set', async () => {
    await api.listPayments(MERCHANT, {
      status: 'captured',
      from: '2026-10-29T18:30:00.000Z',
      to: undefined,
      starting_after: '',
    });
    expect(sent().url).toBe(
      'http://api.test/dashboard/payments?limit=20&status=captured&from=2026-10-29T18%3A30%3A00.000Z',
    );
  });

  it('puts IDs into the path escaped, so an ID cannot reach another route', async () => {
    await api.getPayment(MERCHANT, '../api_keys');
    expect(sent().url).toBe('http://api.test/dashboard/payments/..%2Fapi_keys');
  });

  it('refunds with the amount, if any, and the Idempotency-Key', async () => {
    await api.createRefund(MERCHANT, 'pay_1', { amount: 20_000 }, 'key-1');
    const { url, init, headers } = sent();
    expect(url).toBe('http://api.test/dashboard/payments/pay_1/refunds');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"amount":20000}');
    expect(headers.get('idempotency-key')).toBe('key-1');
  });

  it('refunds what is left when no amount is given', async () => {
    await api.createRefund(MERCHANT, 'pay_1', {}, 'key-2');
    expect(sent().init.body).toBe('{}');
  });

  it('creates a webhook endpoint with an Idempotency-Key', async () => {
    await api.createWebhookEndpoint(
      MERCHANT,
      { url: 'https://shop.test/hooks', event_types: ['payment.captured'] },
      'key-3',
    );
    const { url, init, headers } = sent();
    expect(url).toBe('http://api.test/dashboard/webhook_endpoints');
    expect(init.body).toBe('{"url":"https://shop.test/hooks","event_types":["payment.captured"]}');
    expect(headers.get('idempotency-key')).toBe('key-3');
  });

  it('replays an event to every endpoint, with an Idempotency-Key', async () => {
    await api.redeliverEvent(MERCHANT, 'evt_1', 'key-4');
    const { url, init, headers } = sent();
    expect(url).toBe('http://api.test/dashboard/events/evt_1/redeliver');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(headers.get('idempotency-key')).toBe('key-4');
  });
});
