import { beforeEach, describe, expect, it, vi } from 'vitest';

// Server Actions are public endpoints: anyone can POST to them with any arguments. These tests
// check that every dashboard action takes the merchant only from the session, checks its input
// before calling the API, and handles idempotency keys so a repeat can't refund or replay twice.

const MERCHANT = 'mer_8fK2mQx9LpZ3aB';
const OTHER_MERCHANT = 'mer_0therMerchant00';
const PAYMENT = 'pay_8fK2mQx9LpZ3aB';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('@/lib/session', () => ({
  requireMerchant: vi.fn(async () => ({ merchantId: MERCHANT, name: 'Demo', email: 'd@x.test' })),
}));
vi.mock('@/lib/dashboard-api', () => ({
  createRefund: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  createWebhookEndpoint: vi.fn(),
  deleteWebhookEndpoint: vi.fn(),
  testWebhookEndpoint: vi.fn(),
  redeliverEvent: vi.fn(),
  resolveReconciliationIssue: vi.fn(),
}));

const api = await import('@/lib/dashboard-api');
const { refresh } = await import('next/cache');
const { refundPayment } = await import('./payments/[id]/actions');
const { createKey, revokeKey } = await import('./api-keys/actions');
const { createEndpoint, deleteEndpoint, sendTestEvent } = await import('./webhooks/actions');
const { replayEvent } = await import('./events/actions');
const { resolveIssue } = await import('./reconciliation/actions');

const ok = <T>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message = 'Nope', field?: string) => ({
  ok: false as const,
  error: { code, message, field },
});

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  // A forged merchant ID in the form must be ignored.
  data.set('merchant_id', OTHER_MERCHANT);
  for (const [name, value] of Object.entries(fields)) {
    for (const v of [value].flat()) data.append(name, v);
  }
  return data;
}

const KEYED = { status: 'idle' as const, idempotencyKey: KEY };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('refundPayment', () => {
  const refund = (overrides = {}) => ({
    id: 'rfnd_1',
    payment_id: PAYMENT,
    amount: 1_250,
    status: 'processed',
    failure_reason: null,
    processed_at: null,
    created_at: '2026-10-30T10:00:00.000Z',
    ...overrides,
  });

  it('refunds rupees typed by the user as paise, for the session merchant, with the form key', async () => {
    vi.mocked(api.createRefund).mockResolvedValue(ok(refund()) as never);

    const state = await refundPayment(
      PAYMENT,
      KEYED,
      form({ amount: '12.50', idempotency_key: KEY }),
    );

    expect(api.createRefund).toHaveBeenCalledWith(MERCHANT, PAYMENT, { amount: 1_250 }, KEY);
    expect(state).toMatchObject({ status: 'done', message: 'Refunded ₹12.50.' });
    // The refund is done: the next refund on this page needs a new key.
    expect(state.idempotencyKey).not.toBe(KEY);
    expect(refresh).toHaveBeenCalled();
  });

  it('refunds whatever is left when the amount is empty', async () => {
    vi.mocked(api.createRefund).mockResolvedValue(ok(refund()) as never);
    await refundPayment(PAYMENT, KEYED, form({ amount: ' ', idempotency_key: KEY }));
    expect(api.createRefund).toHaveBeenCalledWith(MERCHANT, PAYMENT, {}, KEY);
  });

  it('reports a refund the bank refused', async () => {
    vi.mocked(api.createRefund).mockResolvedValue(
      ok(refund({ status: 'failed', failure_reason: 'bank_declined' })) as never,
    );
    const state = await refundPayment(PAYMENT, KEYED, form({ amount: '', idempotency_key: KEY }));
    expect(state).toMatchObject({
      status: 'error',
      message: expect.stringContaining('bank_declined'),
    });
  });

  it.each(['abc', '1.234', '-5', '0'])(
    'rejects the amount %j without calling the API',
    async (amount) => {
      const state = await refundPayment(PAYMENT, KEYED, form({ amount, idempotency_key: KEY }));
      expect(state).toMatchObject({ status: 'error', field: 'amount', idempotencyKey: KEY });
      expect(api.createRefund).not.toHaveBeenCalled();
    },
  );

  it('rejects a bad payment ID or a missing key without calling the API', async () => {
    expect(await refundPayment('../x', KEYED, form({ idempotency_key: KEY }))).toMatchObject({
      status: 'error',
    });
    expect(await refundPayment(PAYMENT, KEYED, form({ amount: '1' }))).toMatchObject({
      status: 'error',
    });
    expect(api.createRefund).not.toHaveBeenCalled();
  });

  it("uses a new key after the API's final answer, and keeps it when the answer is unknown", async () => {
    vi.mocked(api.createRefund).mockResolvedValueOnce(
      fail('invalid_state', 'Refund is more than is left', 'amount') as never,
    );
    const refused = await refundPayment(
      PAYMENT,
      KEYED,
      form({ amount: '600', idempotency_key: KEY }),
    );
    // The API stored that answer under KEY, so a corrected amount must go with a fresh key.
    expect(refused).toMatchObject({ status: 'error', field: 'amount' });
    expect(refused.idempotencyKey).not.toBe(KEY);

    vi.mocked(api.createRefund).mockResolvedValueOnce(fail('unavailable') as never);
    const unknown = await refundPayment(
      PAYMENT,
      KEYED,
      form({ amount: '1', idempotency_key: KEY }),
    );
    // Maybe it happened: retrying with the same key replays instead of refunding twice.
    expect(unknown).toMatchObject({ status: 'error', idempotencyKey: KEY });
  });
});

describe('API keys', () => {
  it('creates a key for the session merchant and hands back the secret once', async () => {
    vi.mocked(api.createApiKey).mockResolvedValue(
      ok({ id: 'key_1', prefix: 'sk_test_abcd', key: 'sk_test_full' }) as never,
    );
    const state = await createKey();
    expect(api.createApiKey).toHaveBeenCalledWith(MERCHANT);
    expect(state).toMatchObject({ status: 'done', secret: 'sk_test_full' });
  });

  it('revokes a key for the session merchant', async () => {
    vi.mocked(api.revokeApiKey).mockResolvedValue(ok({}) as never);
    const state = await revokeKey('key_8fK2mQx9LpZ3aB');
    expect(api.revokeApiKey).toHaveBeenCalledWith(MERCHANT, 'key_8fK2mQx9LpZ3aB');
    expect(state.status).toBe('done');
    expect(refresh).toHaveBeenCalled();
  });

  it('refuses to revoke something that is not a key ID', async () => {
    expect(await revokeKey('pay_8fK2mQx9LpZ3aB')).toMatchObject({
      status: 'error',
    });
    expect(api.revokeApiKey).not.toHaveBeenCalled();
  });
});

describe('webhook endpoints', () => {
  const created = { id: 'we_1', url: 'https://shop.test/hooks', secret: 'whsec_abc' };

  it('creates an endpoint for the chosen event types and hands back the secret once', async () => {
    vi.mocked(api.createWebhookEndpoint).mockResolvedValue(ok(created) as never);
    const state = await createEndpoint(
      KEYED,
      form({
        url: 'https://shop.test/hooks',
        event_types: ['payment.captured', 'refund.processed'],
        idempotency_key: KEY,
      }),
    );
    expect(api.createWebhookEndpoint).toHaveBeenCalledWith(
      MERCHANT,
      { url: 'https://shop.test/hooks', event_types: ['payment.captured', 'refund.processed'] },
      KEY,
    );
    expect(state).toMatchObject({ status: 'done', secret: 'whsec_abc' });
    expect(state.idempotencyKey).not.toBe(KEY);
  });

  it('subscribes to everything with "All events"', async () => {
    vi.mocked(api.createWebhookEndpoint).mockResolvedValue(ok(created) as never);
    await createEndpoint(
      KEYED,
      form({
        url: 'https://shop.test/hooks',
        all_events: 'on',
        event_types: 'ping',
        idempotency_key: KEY,
      }),
    );
    expect(api.createWebhookEndpoint).toHaveBeenCalledWith(
      MERCHANT,
      { url: 'https://shop.test/hooks', event_types: ['*'] },
      KEY,
    );
  });

  it.each([
    ['a URL that is not http(s)', { url: 'ftp://shop.test', all_events: 'on' }, 'url'],
    ['no event types', { url: 'https://shop.test/hooks' }, 'event_types'],
    [
      'an unknown event type',
      { url: 'https://shop.test/hooks', event_types: 'order.made' },
      'event_types',
    ],
  ])('rejects %s without calling the API', async (_name, fields, field) => {
    const state = await createEndpoint(KEYED, form({ ...fields, idempotency_key: KEY }));
    expect(state).toMatchObject({ status: 'error', field });
    expect(api.createWebhookEndpoint).not.toHaveBeenCalled();
  });

  it("shows the API's reason, e.g. a private address the SSRF check refused", async () => {
    vi.mocked(api.createWebhookEndpoint).mockResolvedValue(
      fail('validation_error', 'URL resolves to a private address', 'url') as never,
    );
    const state = await createEndpoint(
      KEYED,
      form({ url: 'https://internal.test', all_events: 'on', idempotency_key: KEY }),
    );
    expect(state).toMatchObject({
      status: 'error',
      field: 'url',
      message: 'URL resolves to a private address',
    });
  });

  it('deletes an endpoint for the session merchant', async () => {
    vi.mocked(api.deleteWebhookEndpoint).mockResolvedValue(ok({}) as never);
    expect(await deleteEndpoint('we_8fK2mQx9LpZ3aB')).toMatchObject({
      status: 'done',
    });
    expect(api.deleteWebhookEndpoint).toHaveBeenCalledWith(MERCHANT, 'we_8fK2mQx9LpZ3aB');
  });

  it('sends a test event and says how the endpoint answered', async () => {
    vi.mocked(api.testWebhookEndpoint).mockResolvedValueOnce(
      ok({
        id: 'wd_1',
        status: 'succeeded',
        last_response_status: 200,
        last_response_ms: 41,
      }) as never,
    );
    expect(await sendTestEvent('we_8fK2mQx9LpZ3aB')).toEqual({
      status: 'done',
      message: 'Delivered: HTTP 200 in 41 ms.',
    });
    expect(api.testWebhookEndpoint).toHaveBeenCalledWith(MERCHANT, 'we_8fK2mQx9LpZ3aB');

    vi.mocked(api.testWebhookEndpoint).mockResolvedValueOnce(
      ok({ id: 'wd_2', status: 'pending', last_response_status: 500, last_error: null }) as never,
    );
    expect(await sendTestEvent('we_8fK2mQx9LpZ3aB')).toEqual({
      status: 'error',
      message: 'Not delivered (HTTP 500). We will retry it.',
    });
  });
});

describe('replayEvent', () => {
  it('replays the event for the session merchant with the form key', async () => {
    vi.mocked(api.redeliverEvent).mockResolvedValue(ok({ data: [{ id: 'wd_1' }] }) as never);
    const state = await replayEvent('evt_8fK2mQx9LpZ3aB', KEYED, form({ idempotency_key: KEY }));
    expect(api.redeliverEvent).toHaveBeenCalledWith(MERCHANT, 'evt_8fK2mQx9LpZ3aB', KEY);
    expect(state).toMatchObject({ status: 'done' });
    expect(state.idempotencyKey).not.toBe(KEY);
  });

  it('refuses a bad event ID', async () => {
    expect(await replayEvent('evt_x', KEYED, form({ idempotency_key: KEY }))).toMatchObject({
      status: 'error',
    });
    expect(api.redeliverEvent).not.toHaveBeenCalled();
  });
});

describe('resolveIssue', () => {
  it('marks an issue resolved for the session merchant', async () => {
    vi.mocked(api.resolveReconciliationIssue).mockResolvedValue(ok({}) as never);
    const id = '2f1c3b8e-1d4a-4c55-9a3e-6f0b7d2e9c11';
    expect(await resolveIssue(id)).toMatchObject({ status: 'done' });
    expect(api.resolveReconciliationIssue).toHaveBeenCalledWith(MERCHANT, id);
  });

  it('refuses an ID that is not a UUID', async () => {
    expect(await resolveIssue('1 OR 1=1')).toMatchObject({ status: 'error' });
    expect(api.resolveReconciliationIssue).not.toHaveBeenCalled();
  });
});
