import { describe, expect, it } from 'vitest';
import { generateWebhookSecret } from './secrets';
import { signWebhook, verifyWebhook, webhookHeaders } from './webhook-signature';

// The test vector from the Standard Webhooks spec's reference libraries.
const vector = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};
const vectorNow = new Date(vector.timestamp * 1000);

function vectorHeaders(signature = vector.signature) {
  return {
    'webhook-id': vector.id,
    'webhook-timestamp': String(vector.timestamp),
    'webhook-signature': signature,
  };
}

describe('signWebhook', () => {
  it('matches the Standard Webhooks test vector', () => {
    expect(signWebhook(vector)).toBe(vector.signature);
  });

  it('builds the three webhook-* headers', () => {
    expect(webhookHeaders(vector)).toEqual(vectorHeaders());
  });
});

describe('verifyWebhook', () => {
  const verify = (overrides: Partial<Parameters<typeof verifyWebhook>[0]> = {}) =>
    verifyWebhook({
      headers: vectorHeaders(),
      body: vector.body,
      secret: vector.secret,
      now: vectorNow,
      ...overrides,
    });

  it('accepts a valid signature', () => {
    expect(verify()).toBe(true);
  });

  it('accepts a body given as raw bytes', () => {
    expect(verify({ body: Buffer.from(vector.body) })).toBe(true);
  });

  it('accepts any one valid signature among several (secret rotation)', () => {
    const headers = vectorHeaders(`v1,bm90LXRoZS1yaWdodC1vbmU= ${vector.signature}`);
    expect(verify({ headers })).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verify({ body: '{"test": 2432232315}' })).toBe(false);
  });

  it('rejects re-serialized JSON, even with the same meaning', () => {
    expect(verify({ body: JSON.stringify(JSON.parse(vector.body)) })).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verify({ secret: generateWebhookSecret() })).toBe(false);
  });

  it('rejects a changed webhook-id', () => {
    expect(verify({ headers: { ...vectorHeaders(), 'webhook-id': 'msg_other' } })).toBe(false);
  });

  it.each([
    ['more than 5 minutes old', vector.timestamp * 1000 + 301_000],
    ['more than 5 minutes in the future', vector.timestamp * 1000 - 301_000],
  ])('rejects a timestamp %s', (_name, nowMs) => {
    expect(verify({ now: new Date(nowMs) })).toBe(false);
  });

  it('accepts a timestamp just inside the 5 minute window', () => {
    expect(verify({ now: new Date(vector.timestamp * 1000 + 299_000) })).toBe(true);
  });

  it.each([
    ['missing headers', {}],
    ['a non-numeric timestamp', { ...vectorHeaders(), 'webhook-timestamp': 'soon' }],
    ['an unknown signature version', vectorHeaders(vector.signature.replace('v1,', 'v2,'))],
  ])('rejects %s', (_name, headers) => {
    expect(verify({ headers })).toBe(false);
  });

  it('round-trips with a freshly generated secret', () => {
    const secret = generateWebhookSecret();
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = webhookHeaders({ id: 'evt_x', timestamp, body: '{}', secret });
    expect(verifyWebhook({ headers, body: '{}', secret })).toBe(true);
  });
});
