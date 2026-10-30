import { createHmac } from 'node:crypto';
import { constantTimeEqual } from './secrets';

// Standard Webhooks (https://www.standardwebhooks.com): HMAC-SHA256 over "{id}.{timestamp}.{body}",
// keyed with the base64-decoded part of the whsec_ secret, sent as "v1,<base64>".

const SECRET_PREFIX = 'whsec_';
const SIGNATURE_VERSION = 'v1';
/** Receivers reject timestamps further than this from their clock, so old webhooks can't be replayed. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface WebhookToSign {
  /** The event ID: the same on every retry, so receivers can skip duplicates. */
  id: string;
  /** Unix seconds. New on each attempt. */
  timestamp: number;
  /** The exact bytes sent. Receivers must verify these, never re-serialized JSON. */
  body: string | Buffer;
  /** The endpoint's whsec_ secret. */
  secret: string;
}

function signingKey(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return Buffer.from(encoded, 'base64');
}

/** The webhook-signature value for one secret: "v1,<base64>". */
export function signWebhook({ id, timestamp, body, secret }: WebhookToSign): string {
  const digest = createHmac('sha256', signingKey(secret))
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest('base64');
  return `${SIGNATURE_VERSION},${digest}`;
}

/** The three headers a webhook request carries. */
export function webhookHeaders(webhook: WebhookToSign): Record<string, string> {
  return {
    'webhook-id': webhook.id,
    'webhook-timestamp': String(webhook.timestamp),
    'webhook-signature': signWebhook(webhook),
  };
}

export interface WebhookToVerify {
  /** Request headers, lower-case names (as Node gives them). */
  headers: Record<string, string | string[] | undefined>;
  /** The raw request body, exactly as received. */
  body: string | Buffer;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}

function header(headers: WebhookToVerify['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * True if the webhook was signed with this secret and its timestamp is recent. The signature
 * header may hold several space-separated signatures (during secret rotation); one match is
 * enough. Comparisons are constant-time.
 */
export function verifyWebhook({
  headers,
  body,
  secret,
  now = new Date(),
  toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
}: WebhookToVerify): boolean {
  const id = header(headers, 'webhook-id');
  const timestampText = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (!id || !timestampText || !signatures || !/^\d+$/.test(timestampText)) return false;

  const timestamp = Number(timestampText);
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = signWebhook({ id, timestamp, body, secret });
  return signatures
    .split(' ')
    .filter((candidate) => candidate.startsWith(`${SIGNATURE_VERSION},`))
    .some((candidate) => constantTimeEqual(candidate, expected));
}
