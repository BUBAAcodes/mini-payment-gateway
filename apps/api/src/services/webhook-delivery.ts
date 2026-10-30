import http from 'node:http';
import https from 'node:https';
import type { Event, Prisma, PrismaClient, WebhookDelivery } from '@gateway/db';
import { decryptSecret, webhookHeaders, type WebhookDeliveryResponse } from '@gateway/shared';
import { checkWebhookUrl, guardedLookup } from './ssrf';
import { retryDelayMs } from './webhook-retry';

/** A webhook succeeds only with a 2xx answer inside this window (spec section 11). */
export const WEBHOOK_TIMEOUT_MS = 15_000;
/** How long a sender owns a delivery it is attempting (the lease in section 9.6). */
export const DELIVERY_LEASE_MS = 30_000;

export interface DeliveryOptions {
  /** APP_ENCRYPTION_KEY, to read the endpoint's signing secret. */
  encryptionKey: string;
  /** ALLOW_PRIVATE_WEBHOOK_URLS. */
  allowPrivate: boolean;
  timeoutMs?: number;
  /** The clock attempts are stamped and retries scheduled with. Tests pass their own. */
  now?: () => Date;
  /** Picks the retry jitter: a number in [0, 1]. */
  random?: () => number;
}

/** The body every webhook carries: { id, type, created_at, data: { object } }. */
export function buildWebhookPayload(event: Event) {
  return {
    id: event.id,
    type: event.type,
    created_at: event.createdAt.toISOString(),
    data: event.payload,
  };
}

/**
 * POSTs the body and resolves with the response status. Redirects are not followed (a 3xx is a
 * failure), and `lookup` refuses private addresses unless they are allowed.
 */
function postWebhook(
  url: URL,
  headers: Record<string, string>,
  body: string,
  { allowPrivate, timeoutMs }: { allowPrivate: boolean; timeoutMs: number },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'Gateway-Webhooks/1.0',
        },
        lookup: allowPrivate ? undefined : guardedLookup(),
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        resolve(res.statusCode ?? 0);
        // The status is all we keep; don't spend time or memory reading the body.
        res.destroy();
      },
    );
    req.on('error', (err) =>
      reject(err.name === 'AbortError' ? new Error(`Timed out after ${timeoutMs} ms`) : err),
    );
    req.end(body);
  });
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';
  const code = (err as NodeJS.ErrnoException).code;
  return code && !err.message.includes(code) ? `${code}: ${err.message}` : err.message;
}

/**
 * Records how an attempt ended, unless the delivery is no longer `pending`. A sender whose lease
 * ran out mid-send may finish after another sender already settled the delivery; its late result
 * must not turn `succeeded` back into `pending`.
 */
async function recordAttempt(
  db: PrismaClient,
  deliveryId: string,
  data: Prisma.WebhookDeliveryUpdateManyMutationInput,
): Promise<WebhookDelivery> {
  await db.webhookDelivery.updateMany({ where: { id: deliveryId, status: 'pending' }, data });
  return db.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
}

/**
 * Makes one signed attempt at a delivery and records the outcome. A 2xx marks it `succeeded`.
 * Anything else schedules the next attempt from the retry schedule, or marks the delivery `failed`
 * when no retries are left. The caller must hold the delivery's lease, and must not be inside a
 * transaction: this waits on the merchant's server (rule 11).
 */
export async function attemptDelivery(
  db: PrismaClient,
  deliveryId: string,
  {
    encryptionKey,
    allowPrivate,
    timeoutMs = WEBHOOK_TIMEOUT_MS,
    now = () => new Date(),
    random = Math.random,
  }: DeliveryOptions,
): Promise<WebhookDelivery> {
  const delivery = await db.webhookDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    include: { event: true, endpoint: true },
  });
  const { event, endpoint } = delivery;

  if (endpoint.deletedAt) {
    return recordAttempt(db, deliveryId, {
      status: 'failed',
      lastError: 'Webhook endpoint was deleted',
      lockedUntil: null,
    });
  }

  const startedAt = now();
  const startedMs = performance.now();
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    // Checked again at send time: DNS may have changed since the URL was saved.
    const problem = await checkWebhookUrl(endpoint.url, { allowPrivate });
    if (problem) throw new Error(problem);

    // Serialized once: the signature covers exactly these bytes.
    const body = JSON.stringify(buildWebhookPayload(event));
    const headers = webhookHeaders({
      id: event.id,
      timestamp: Math.floor(startedAt.getTime() / 1000),
      body,
      secret: decryptSecret(endpoint.secret, encryptionKey),
    });
    statusCode = await postWebhook(new URL(endpoint.url), headers, body, {
      allowPrivate,
      timeoutMs,
    });
    if (statusCode < 200 || statusCode >= 300) error = `HTTP ${statusCode}`;
  } catch (err) {
    error = describeError(err);
  }

  let outcome: Prisma.WebhookDeliveryUpdateManyMutationInput;
  if (error === null) {
    outcome = { status: 'succeeded' };
  } else {
    // The schedule counts from when the attempt ended.
    const retryIn = retryDelayMs(delivery.attemptCount + 1, random);
    outcome =
      retryIn === null
        ? { status: 'failed' }
        : { nextAttemptAt: new Date(now().getTime() + retryIn) };
  }

  return recordAttempt(db, deliveryId, {
    ...outcome,
    attemptCount: { increment: 1 },
    lastAttemptAt: startedAt,
    lastResponseStatus: statusCode,
    lastResponseMs: statusCode === null ? null : Math.round(performance.now() - startedMs),
    lastError: error,
    lockedUntil: null,
  });
}

/** The public JSON shape of a delivery attempt record. */
export function webhookDeliveryResource(d: WebhookDelivery): WebhookDeliveryResponse {
  return {
    id: d.id,
    event_id: d.eventId,
    endpoint_id: d.endpointId,
    status: d.status,
    attempt_count: d.attemptCount,
    // When the sender will try again. Only a pending delivery has one.
    next_attempt_at: d.status === 'pending' ? d.nextAttemptAt.toISOString() : null,
    last_attempt_at: d.lastAttemptAt?.toISOString() ?? null,
    last_response_status: d.lastResponseStatus,
    last_response_ms: d.lastResponseMs,
    last_error: d.lastError,
    created_at: d.createdAt.toISOString(),
  };
}
