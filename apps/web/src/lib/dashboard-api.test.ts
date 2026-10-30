import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real modules only work inside a Next.js request.
vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ connection: async () => {} }));

const { callDashboardApi, getBalance } = await import('./dashboard-api');

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
