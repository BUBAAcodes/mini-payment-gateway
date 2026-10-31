import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  generateCheckoutSecret,
  generateWebhookSecret,
  newId,
  signCheckoutRedirect,
  webhookHeaders,
} from '@gateway/shared';
import { createStoreApp } from '../src/app';
import { loadConfig } from '../src/config';
import type {
  CreateOrderRequest,
  GatewayClient,
  GatewayOrder,
  GatewayPayment,
} from '../src/gateway-client';
import { createOrderStore, type OrderStore } from '../src/order-store';
import { createLogger } from '../src/logger';

const config = loadConfig({
  STORE_BASE_URL: 'http://shop.test',
  GATEWAY_SECRET_KEY: 'sk_test_0123456789abcdefghijklmnopqrstuv',
  GATEWAY_WEBHOOK_SECRET: generateWebhookSecret(),
  GATEWAY_CHECKOUT_SECRET: generateCheckoutSecret(),
});

/** Stands in for the gateway API: records orders it creates and serves payments we put in it. */
function stubGateway() {
  const payments = new Map<string, GatewayPayment>();
  const calls: { input: CreateOrderRequest; idempotencyKey: string }[] = [];
  const gateway = {
    createOrder: vi.fn(async (input: CreateOrderRequest, idempotencyKey: string) => {
      calls.push({ input, idempotencyKey });
      const id = newId('order');
      const order: GatewayOrder = {
        id,
        amount: input.amount,
        currency: input.currency,
        status: 'created',
        receipt: input.receipt,
        client_secret: 'cs_test',
        checkout_url: `http://web.test/pay/${id}?cs=cs_test`,
      };
      return order;
    }),
    getPayment: vi.fn(async (id: string) => payments.get(id) ?? null),
  } satisfies GatewayClient;
  return { gateway, payments, calls };
}

let stub: ReturnType<typeof stubGateway>;
let orders: OrderStore;
let app: Express;

beforeEach(() => {
  stub = stubGateway();
  orders = createOrderStore();
  app = createStoreApp({ config, gateway: stub.gateway, orders, logger: createLogger('silent') });
});

/** Clicks Buy (optionally with a size picked) and returns the gateway order the store created. */
async function buy(size?: string): Promise<GatewayOrder> {
  const res = await request(app)
    .post('/buy')
    .type('form')
    .send(size ? { size } : {})
    .expect(303);
  const order = (await stub.gateway.createOrder.mock.results.at(-1)!.value) as GatewayOrder;
  expect(res.headers.location).toBe(order.checkout_url);
  return order;
}

/** The gateway's view of a payment on `order`. */
function payment(order: GatewayOrder, overrides: Partial<GatewayPayment> = {}): GatewayPayment {
  const p: GatewayPayment = {
    id: newId('pay'),
    order_id: order.id,
    amount: order.amount,
    currency: 'INR',
    status: 'captured',
    failure_reason: null,
    ...overrides,
  };
  stub.payments.set(p.id, p);
  return p;
}

function event(type: string, object: object, id = newId('evt')) {
  return { id, type, created_at: new Date().toISOString(), data: { object } };
}

interface SendOptions {
  /** Sent instead of JSON.stringify(event): lets a test control the exact bytes. */
  rawBody?: string;
  /** Signed over these bytes instead of the ones sent. */
  signedBody?: string;
  timestamp?: number;
  secret?: string;
}

/** POSTs a webhook the way the gateway's sender does: signed raw bytes, JSON content type. */
function sendWebhook(evt: { id: string }, options: SendOptions = {}) {
  const body = options.rawBody ?? JSON.stringify(evt);
  const headers = webhookHeaders({
    id: evt.id,
    timestamp: options.timestamp ?? Math.floor(Date.now() / 1000),
    body: options.signedBody ?? body,
    secret: options.secret ?? config.GATEWAY_WEBHOOK_SECRET,
  });
  return request(app)
    .post('/webhooks/gateway')
    .set(headers)
    .set('content-type', 'application/json')
    .send(body);
}

function callbackQuery(orderId: string, paymentId: string, status: string, signature?: string) {
  return {
    order_id: orderId,
    payment_id: paymentId,
    status,
    signature:
      signature ?? signCheckoutRedirect(orderId, paymentId, config.GATEWAY_CHECKOUT_SECRET),
  };
}

describe('GET /', () => {
  it('shows the T-shirt for ₹500 with a Buy button', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('T-shirt');
    expect(res.text).toContain('₹500.00');
    expect(res.text).toMatch(/<form[^>]+method="post"[^>]+action="\/buy"/);
  });

  it('offers sizes S to XL as radio buttons, with M picked', async () => {
    const res = await request(app).get('/').expect(200);
    for (const size of ['S', 'M', 'L', 'XL']) {
      expect(res.text).toMatch(new RegExp(`<input[^>]+name="size"[^>]+value="${size}"`));
    }
    expect(res.text).toMatch(/<input[^>]+value="M"[^>]+checked/);
  });

  it('draws the shirt inline and loads no images or scripts from anywhere', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('<svg');
    expect(res.text).not.toContain('<img');
    expect(res.text).not.toContain('<script');
  });

  it('links the shop and says it is test mode, on every page', async () => {
    for (const path of ['/', `/orders/${newId('order')}`]) {
      const res = await request(app).get(path);
      expect(res.text).toContain('href="/"');
      expect(res.text).toMatch(/test mode/i);
      expect(res.text).toMatch(/kept in memory/i);
    }
  });
});

describe('security headers', () => {
  it('lets the Buy form redirect to checkout on another origin', async () => {
    const res = await request(app).get('/').expect(200);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('form-action');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('allows the Inter web font from Google Fonts', async () => {
    const res = await request(app).get('/').expect(200);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toMatch(/style-src [^;]*https:/);
    expect(csp).toMatch(/font-src [^;]*https:/);
    expect(res.text).toContain('https://fonts.googleapis.com/css2?family=Inter');
  });
});

describe('GET /health', () => {
  it('answers 200', async () => {
    await request(app).get('/health').expect(200);
  });
});

describe('POST /buy', () => {
  it('creates a ₹500 order with an idempotency key and sends the customer to checkout', async () => {
    const order = await buy();

    expect(stub.calls).toHaveLength(1);
    const [{ input, idempotencyKey }] = stub.calls as [(typeof stub.calls)[number]];
    expect(input).toMatchObject({
      amount: 50_000,
      currency: 'INR',
      callback_url: 'http://shop.test/payments/callback',
    });
    expect(input.receipt).toMatch(/^store_/);
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(orders.getOrder(order.id)).toMatchObject({
      id: order.id,
      amount: 50_000,
      status: 'awaiting_payment',
      checkoutUrl: order.checkout_url,
    });
  });

  it('sends the chosen size to the gateway in the order notes, and remembers it', async () => {
    const order = await buy('L');
    expect(stub.calls[0]!.input.notes).toEqual({ size: 'L' });
    expect(orders.getOrder(order.id)!.size).toBe('L');
  });

  it('defaults to size M', async () => {
    await buy();
    expect(stub.calls[0]!.input.notes).toEqual({ size: 'M' });
  });

  it('refuses a size it does not sell, without creating an order', async () => {
    const res = await request(app).post('/buy').type('form').send({ size: 'XXL' }).expect(400);
    expect(res.text).toMatch(/size/i);
    expect(stub.gateway.createOrder).not.toHaveBeenCalled();
  });

  it('uses a new idempotency key for each purchase', async () => {
    await buy();
    await buy();
    const [first, second] = stub.calls;
    expect(first!.idempotencyKey).not.toBe(second!.idempotencyKey);
  });

  it('shows an error page when the gateway cannot create the order', async () => {
    stub.gateway.createOrder.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const res = await request(app).post('/buy').expect(502);
    expect(res.text).toContain('try again');
    expect(res.text).not.toContain('ECONNREFUSED');
  });
});

describe('GET /payments/callback', () => {
  it('accepts a valid signature and redirects to the order page without fulfilling', async () => {
    const order = await buy();
    const p = payment(order);
    const res = await request(app)
      .get('/payments/callback')
      .query(callbackQuery(order.id, p.id, 'captured'))
      .expect(303);

    // A redirect, not a page: the callback never becomes a history entry the Back button could
    // land on and be bounced forward from.
    expect(res.headers.location).toBe(`/orders/${order.id}`);
    // The redirect's status isn't signed: only a webhook plus a re-fetch fulfils.
    expect(orders.getOrder(order.id)!.status).toBe('awaiting_payment');
    expect(stub.gateway.getPayment).not.toHaveBeenCalled();
  });

  it('rejects a tampered signature', async () => {
    const order = await buy();
    const q = callbackQuery(order.id, 'pay_x', 'captured');
    const tampered = (q.signature[0] === 'a' ? 'b' : 'a') + q.signature.slice(1);
    await request(app)
      .get('/payments/callback')
      .query({ ...q, signature: tampered })
      .expect(400);
  });

  it('rejects a signature made for a different payment', async () => {
    const order = await buy();
    const q = callbackQuery(order.id, 'pay_aaaaaaaaaaaaaa', 'captured');
    await request(app)
      .get('/payments/callback')
      .query({ ...q, payment_id: 'pay_bbbbbbbbbbbbbb' })
      .expect(400);
  });

  it('rejects a signature made with another secret', async () => {
    const order = await buy();
    const signature = signCheckoutRedirect(order.id, 'pay_x', generateCheckoutSecret());
    await request(app)
      .get('/payments/callback')
      .query(callbackQuery(order.id, 'pay_x', 'captured', signature))
      .expect(400);
  });

  it('rejects a callback with missing parameters', async () => {
    const order = await buy();
    await request(app).get('/payments/callback').query({ order_id: order.id }).expect(400);
  });

  it('returns 404 for an order this store never made', async () => {
    const orderId = newId('order');
    await request(app)
      .get('/payments/callback')
      .query(callbackQuery(orderId, 'pay_x', 'captured'))
      .expect(404);
  });

  it('passes a failed result on to the order page as a hint', async () => {
    const order = await buy();
    const res = await request(app)
      .get('/payments/callback')
      .query(callbackQuery(order.id, 'pay_x', 'failed'))
      .expect(303);
    expect(res.headers.location).toBe(`/orders/${order.id}?payment=failed`);
    expect(orders.getOrder(order.id)!.status).toBe('awaiting_payment');
  });
});

describe('POST /webhooks/gateway', () => {
  it('re-fetches the payment and fulfils the order on payment.captured', async () => {
    const order = await buy();
    const p = payment(order);
    await sendWebhook(event('payment.captured', p)).expect(200);

    expect(stub.gateway.getPayment).toHaveBeenCalledWith(p.id, expect.any(String));
    expect(orders.getOrder(order.id)).toMatchObject({ status: 'fulfilled', paymentId: p.id });
  });

  it('skips a webhook ID it has already processed', async () => {
    const order = await buy();
    const p = payment(order);
    const evt = event('payment.captured', p);
    await sendWebhook(evt).expect(200);
    await sendWebhook(evt).expect(200);

    expect(stub.gateway.getPayment).toHaveBeenCalledTimes(1);
  });

  it('rejects a tampered body', async () => {
    const order = await buy();
    const p = payment(order);
    const evt = event('payment.captured', p);
    const signedBody = JSON.stringify(evt);
    const rawBody = signedBody.replace(p.id, newId('pay'));
    await sendWebhook(evt, { rawBody, signedBody }).expect(400);

    expect(orders.getOrder(order.id)!.status).toBe('awaiting_payment');
    expect(stub.gateway.getPayment).not.toHaveBeenCalled();
  });

  it('rejects a timestamp more than 5 minutes old (a replayed webhook)', async () => {
    const order = await buy();
    const evt = event('payment.captured', payment(order));
    await sendWebhook(evt, { timestamp: Math.floor(Date.now() / 1000) - 6 * 60 }).expect(400);
    expect(orders.getOrder(order.id)!.status).toBe('awaiting_payment');
  });

  it('rejects a webhook signed with another secret', async () => {
    const order = await buy();
    const evt = event('payment.captured', payment(order));
    await sendWebhook(evt, { secret: generateWebhookSecret() }).expect(400);
  });

  it('rejects a webhook with no signature headers', async () => {
    await request(app)
      .post('/webhooks/gateway')
      .set('content-type', 'application/json')
      .send(JSON.stringify(event('ping', {})))
      .expect(400);
  });

  it('verifies the raw bytes, not re-serialized JSON', async () => {
    const order = await buy();
    const p = payment(order);
    const evt = event('payment.captured', p);
    // Spacing that JSON.stringify would never produce: re-serializing would change the bytes.
    const rawBody = JSON.stringify(evt, null, 2);
    await sendWebhook(evt, { rawBody }).expect(200);
    expect(orders.getOrder(order.id)!.status).toBe('fulfilled');
  });

  it('does not fulfil when the re-fetched payment is not captured', async () => {
    const order = await buy();
    // The webhook claims "captured", but the API is the source of truth.
    const p = payment(order, { status: 'failed', failure_reason: 'insufficient_funds' });
    await sendWebhook(event('payment.captured', { ...p, status: 'captured' })).expect(200);
    expect(orders.getOrder(order.id)!.status).toBe('awaiting_payment');
  });

  it('does not fulfil when the captured amount differs from the order', async () => {
    const order = await buy();
    const p = payment(order, { amount: 100 });
    await sendWebhook(event('payment.captured', p)).expect(200);
    expect(orders.getOrder(order.id)!.status).toBe('awaiting_payment');
  });

  it('marks the order failed on payment.failed', async () => {
    const order = await buy();
    const p = payment(order, { status: 'failed', failure_reason: 'insufficient_funds' });
    await sendWebhook(event('payment.failed', p)).expect(200);
    expect(orders.getOrder(order.id)!.status).toBe('payment_failed');
  });

  it('fulfils after a failed attempt when a retry is captured', async () => {
    const order = await buy();
    const failed = payment(order, { status: 'failed', failure_reason: 'insufficient_funds' });
    const captured = payment(order);
    await sendWebhook(event('payment.failed', failed)).expect(200);
    await sendWebhook(event('payment.captured', captured)).expect(200);
    expect(orders.getOrder(order.id)).toMatchObject({
      status: 'fulfilled',
      paymentId: captured.id,
    });
  });

  it("stays fulfilled when an older attempt's payment.failed arrives late (out of order)", async () => {
    const order = await buy();
    const failed = payment(order, { status: 'failed', failure_reason: 'insufficient_funds' });
    const captured = payment(order);
    await sendWebhook(event('payment.captured', captured)).expect(200);
    await sendWebhook(event('payment.failed', failed)).expect(200);
    expect(orders.getOrder(order.id)).toMatchObject({
      status: 'fulfilled',
      paymentId: captured.id,
    });
  });

  it('answers 500 when the re-fetch fails, and handles the retry with the same ID', async () => {
    const order = await buy();
    const p = payment(order);
    const evt = event('payment.captured', p);
    stub.gateway.getPayment.mockRejectedValueOnce(new Error('gateway unavailable'));

    await sendWebhook(evt).expect(500);
    expect(orders.getOrder(order.id)!.status).toBe('awaiting_payment');

    await sendWebhook(evt).expect(200);
    expect(orders.getOrder(order.id)!.status).toBe('fulfilled');
  });

  it('acknowledges a ping', async () => {
    await sendWebhook(event('ping', { message: 'hello' })).expect(200);
    expect(stub.gateway.getPayment).not.toHaveBeenCalled();
  });

  it('acknowledges events for orders it does not know, so they are not retried forever', async () => {
    const stranger = payment({ ...(await buy()), id: newId('order') });
    await sendWebhook(event('payment.captured', stranger)).expect(200);
  });

  it('acknowledges event types it does not act on', async () => {
    await sendWebhook(event('refund.processed', { id: newId('rfnd') })).expect(200);
  });

  it('rejects a signed body that is not a webhook event', async () => {
    await sendWebhook({ id: newId('evt') }, { rawBody: 'not json' }).expect(400);
  });
});

describe('GET /orders/:id', () => {
  it('shows a waiting order as confirming, and refreshes only itself', async () => {
    const order = await buy('L');
    const res = await request(app).get(`/orders/${order.id}`).expect(200);
    expect(res.text).toMatch(/payment received, confirming/i);
    // Reloads the same URL: no new history entry, so Back still goes to the shop.
    expect(res.text).toMatch(/http-equiv="refresh"\s+content="2"/);
    expect(res.text).not.toContain('url=');
    expect(res.text).toContain('Size L');
  });

  it('offers a way back to the shop and another purchase', async () => {
    const order = await buy('S');
    const res = await request(app).get(`/orders/${order.id}`).expect(200);
    expect(res.text).toMatch(/<a[^>]+href="\/"[^>]*>\s*Continue shopping/);
    expect(res.text).toMatch(
      /<form[^>]+action="\/buy"[\s\S]*name="size"[^>]+value="S"[\s\S]*Buy another/,
    );
  });

  it('shows "not completed" with Try again when checkout says the payment failed', async () => {
    const order = await buy();
    const res = await request(app).get(`/orders/${order.id}?payment=failed`).expect(200);
    expect(res.text).toMatch(/payment not completed/i);
    expect(res.text).toContain(`href="${order.checkout_url}"`);
    expect(res.text).not.toContain('http-equiv="refresh"');
  });

  it('ignores the failed hint once the webhook has fulfilled the order', async () => {
    const order = await buy();
    await sendWebhook(event('payment.captured', payment(order))).expect(200);
    const res = await request(app).get(`/orders/${order.id}?payment=failed`).expect(200);
    expect(res.text).toMatch(/fulfilled/i);
    expect(res.text).not.toMatch(/not completed/i);
  });

  it('shows Try again after a payment.failed webhook', async () => {
    const order = await buy();
    await sendWebhook(event('payment.failed', payment(order, { status: 'failed' }))).expect(200);
    const res = await request(app).get(`/orders/${order.id}`).expect(200);
    expect(res.text).toMatch(/payment failed/i);
    expect(res.text).toContain(`href="${order.checkout_url}"`);
    expect(res.text).not.toContain('http-equiv="refresh"');
  });

  it('shows "fulfilled" once the webhook has arrived, and stops refreshing', async () => {
    const order = await buy();
    await sendWebhook(event('payment.captured', payment(order))).expect(200);
    const res = await request(app).get(`/orders/${order.id}`).expect(200);
    expect(res.text).toMatch(/fulfilled/i);
    expect(res.text).not.toContain('http-equiv="refresh"');
  });

  it('returns 404 for an unknown order', async () => {
    await request(app)
      .get(`/orders/${newId('order')}`)
      .expect(404);
  });

  it('escapes what it puts in the page', async () => {
    const res = await request(app).get('/orders/<img src=x onerror=alert(1)>').expect(404);
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.text).not.toContain('<img');
  });
});
