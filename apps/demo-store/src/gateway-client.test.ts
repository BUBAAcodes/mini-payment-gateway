import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayClient, GatewayError, type CreateOrderRequest } from './gateway-client';

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** One scripted answer: a status and JSON body, or `hang` to never answer. */
type Reply = { status: number; body: unknown } | 'hang';

let server: Server | undefined;

/** A pretend gateway API that answers with `replies` in turn (the last one repeats). */
async function fakeApi(replies: Reply[]) {
  const received: Received[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const reply = replies[Math.min(received.length, replies.length - 1)]!;
      received.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (reply === 'hang') return;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, received };
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
  server = undefined;
});

const API_KEY = 'sk_test_0123456789abcdefghijklmnopqrstuv';

const orderInput: CreateOrderRequest = {
  amount: 50_000,
  currency: 'INR',
  receipt: 'store_abc',
  callback_url: 'http://shop.test/payments/callback',
};

const createdOrder = {
  id: 'order_8fK2mQx9LpZ3aB',
  amount: 50_000,
  currency: 'INR',
  status: 'created',
  receipt: 'store_abc',
  client_secret: 'cs_x',
  checkout_url: 'http://web.test/pay/order_8fK2mQx9LpZ3aB?cs=cs_x',
};

function client(baseUrl: string, timeoutMs = 1_000) {
  return createGatewayClient({ baseUrl, apiKey: API_KEY, timeoutMs, retryDelaysMs: [0, 0] });
}

describe('createOrder', () => {
  it('sends the API key, the idempotency key and the order as JSON', async () => {
    const api = await fakeApi([{ status: 201, body: createdOrder }]);
    const order = await client(api.baseUrl).createOrder(orderInput, 'key-1', 'req-1');

    expect(order).toEqual(createdOrder);
    expect(api.received).toHaveLength(1);
    const [req] = api.received;
    expect(req).toMatchObject({ method: 'POST', url: '/v1/orders' });
    expect(req!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(req!.headers['idempotency-key']).toBe('key-1');
    expect(req!.headers['x-request-id']).toBe('req-1');
    expect(JSON.parse(req!.body)).toEqual(orderInput);
  });

  it('retries a 5xx with the same idempotency key, so a retry never makes a second order', async () => {
    const api = await fakeApi([
      { status: 503, body: { error: { code: 'internal_error', message: 'down' } } },
      { status: 201, body: createdOrder },
    ]);
    const order = await client(api.baseUrl).createOrder(orderInput, 'key-2');

    expect(order.id).toBe(createdOrder.id);
    expect(api.received.map((r) => r.headers['idempotency-key'])).toEqual(['key-2', 'key-2']);
  });

  it('retries while the first request with that key is still running (409)', async () => {
    const api = await fakeApi([
      { status: 409, body: { error: { code: 'idempotency_in_progress', message: 'wait' } } },
      { status: 201, body: createdOrder },
    ]);
    await expect(client(api.baseUrl).createOrder(orderInput, 'key-3')).resolves.toEqual(
      createdOrder,
    );
    expect(api.received).toHaveLength(2);
  });

  it('retries a timeout with the same key', async () => {
    const api = await fakeApi(['hang', { status: 201, body: createdOrder }]);
    await expect(client(api.baseUrl, 100).createOrder(orderInput, 'key-4')).resolves.toEqual(
      createdOrder,
    );
    expect(api.received.map((r) => r.headers['idempotency-key'])).toEqual(['key-4', 'key-4']);
  });

  it('does not retry a request the API rejected (400), and reports its error', async () => {
    const api = await fakeApi([
      {
        status: 400,
        body: { error: { code: 'validation_error', message: 'bad amount', field: 'amount' } },
      },
    ]);
    const err = await client(api.baseUrl)
      .createOrder(orderInput, 'key-5')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ status: 400, code: 'validation_error' });
    expect(api.received).toHaveLength(1);
  });

  it('gives up after three attempts', async () => {
    const api = await fakeApi([{ status: 500, body: {} }]);
    await expect(client(api.baseUrl).createOrder(orderInput, 'key-6')).rejects.toBeInstanceOf(
      GatewayError,
    );
    expect(api.received).toHaveLength(3);
  });
});

describe('getPayment', () => {
  const payment = {
    id: 'pay_8fK2mQx9LpZ3aB',
    order_id: createdOrder.id,
    amount: 50_000,
    currency: 'INR',
    status: 'captured',
    failure_reason: null,
  };

  it('fetches the payment with the API key', async () => {
    const api = await fakeApi([{ status: 200, body: payment }]);
    await expect(client(api.baseUrl).getPayment(payment.id)).resolves.toMatchObject(payment);
    expect(api.received[0]).toMatchObject({ method: 'GET', url: `/v1/payments/${payment.id}` });
    expect(api.received[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('returns null when the API has no such payment for this merchant', async () => {
    const api = await fakeApi([{ status: 404, body: { error: { code: 'not_found' } } }]);
    await expect(client(api.baseUrl).getPayment(payment.id)).resolves.toBeNull();
  });

  it('throws on a server error, so the webhook is answered 500 and retried later', async () => {
    const api = await fakeApi([{ status: 502, body: {} }]);
    await expect(client(api.baseUrl).getPayment(payment.id)).rejects.toBeInstanceOf(GatewayError);
  });

  it('puts the ID in the path safely', async () => {
    const api = await fakeApi([{ status: 404, body: {} }]);
    await client(api.baseUrl).getPayment('../orders/x');
    expect(api.received[0]!.url).toBe('/v1/payments/..%2Forders%2Fx');
  });
});
