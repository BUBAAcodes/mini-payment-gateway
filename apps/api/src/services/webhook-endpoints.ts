import type { Prisma, PrismaClient, WebhookDelivery, WebhookEndpoint } from '@gateway/db';
import {
  NotFoundError,
  ValidationError,
  encryptSecret,
  generateWebhookSecret,
  isId,
  newId,
  type CreateWebhookEndpointInput,
  type WebhookEndpointResponse,
} from '@gateway/shared';
import { recordEvent } from './events';
import { olderThan, toPage, type Page } from './pagination';
import { assertWebhookUrlAllowed } from './ssrf';
import { DELIVERY_LEASE_MS, attemptDelivery } from './webhook-delivery';

export interface WebhookEndpointOptions {
  /** APP_ENCRYPTION_KEY: the signing secret is stored encrypted (rule 8). */
  encryptionKey: string;
  /** ALLOW_PRIVATE_WEBHOOK_URLS. */
  allowPrivate: boolean;
}

export interface CreatedWebhookEndpoint {
  endpoint: WebhookEndpoint;
  /** The whsec_ signing secret. Only its ciphertext is stored; show this copy once. */
  secret: string;
}

/** Live endpoints of one merchant. Deleted ones keep their delivery history but are invisible. */
export function liveEndpoints(merchantId: string): Prisma.WebhookEndpointWhereInput {
  return { merchantId, deletedAt: null };
}

/** True if an endpoint with these event_types wants events of this type. */
export function isSubscribed(eventTypes: string[], type: string): boolean {
  return eventTypes.includes('*') || eventTypes.includes(type);
}

export async function createWebhookEndpoint(
  db: PrismaClient,
  merchantId: string,
  input: CreateWebhookEndpointInput,
  { encryptionKey, allowPrivate }: WebhookEndpointOptions,
): Promise<CreatedWebhookEndpoint> {
  await assertWebhookUrlAllowed(input.url, { allowPrivate });
  const secret = generateWebhookSecret();
  const endpoint = await db.webhookEndpoint.create({
    data: {
      id: newId('we'),
      merchantId,
      url: input.url,
      eventTypes: input.event_types,
      secret: encryptSecret(secret, encryptionKey),
    },
  });
  return { endpoint, secret };
}

/** Newest first. `startingAfter` is the last ID of the previous page. */
export async function listWebhookEndpoints(
  db: PrismaClient,
  merchantId: string,
  { limit, startingAfter }: { limit: number; startingAfter?: string },
): Promise<Page<WebhookEndpoint>> {
  let after: Prisma.WebhookEndpointWhereInput = {};
  if (startingAfter !== undefined) {
    // Scoped to the merchant but not to live rows: paging keeps working if the cursor was deleted.
    const cursor = isId('we', startingAfter)
      ? await db.webhookEndpoint.findFirst({ where: { id: startingAfter, merchantId } })
      : null;
    if (!cursor) throw new ValidationError('No such webhook endpoint', 'starting_after');
    after = olderThan(cursor);
  }

  const rows = await db.webhookEndpoint.findMany({
    where: { ...liveEndpoints(merchantId), ...after },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  return toPage(rows, limit);
}

/** Another merchant's endpoint, or a deleted one, is "not found". */
export async function getWebhookEndpoint(
  db: Prisma.TransactionClient,
  merchantId: string,
  endpointId: string,
): Promise<WebhookEndpoint> {
  const endpoint = isId('we', endpointId)
    ? await db.webhookEndpoint.findFirst({
        where: { id: endpointId, ...liveEndpoints(merchantId) },
      })
    : null;
  if (!endpoint) throw new NotFoundError('Webhook endpoint');
  return endpoint;
}

/**
 * Soft delete: the row stays so its deliveries keep their history, but it disappears from the API
 * and never gets another delivery. Deleting twice is "not found".
 */
export async function deleteWebhookEndpoint(
  db: PrismaClient,
  merchantId: string,
  endpointId: string,
): Promise<void> {
  const { count } = isId('we', endpointId)
    ? await db.webhookEndpoint.updateMany({
        where: { id: endpointId, ...liveEndpoints(merchantId) },
        data: { deletedAt: new Date(), enabled: false },
      })
    : { count: 0 };
  if (count === 0) throw new NotFoundError('Webhook endpoint');
}

/**
 * Sends a `ping` event to one endpoint, right now. The event and its delivery are written in one
 * transaction first, so the attempt is on record like any other; then one attempt is made after
 * the commit (rule 11). The event is marked dispatched so the fan-out loop never copies it to the
 * merchant's other endpoints, and the delivery starts leased to this request so the sender loop
 * leaves it alone until the attempt is recorded. A failed ping stays pending for the retry loop.
 */
export async function sendTestWebhook(
  db: PrismaClient,
  merchantId: string,
  endpointId: string,
  options: WebhookEndpointOptions,
): Promise<WebhookDelivery> {
  const delivery = await db.$transaction(async (tx) => {
    const endpoint = await getWebhookEndpoint(tx, merchantId, endpointId);
    const now = new Date();
    const event = await recordEvent(tx, merchantId, 'ping', webhookEndpointResource(endpoint), {
      dispatchedAt: now,
    });
    return tx.webhookDelivery.create({
      data: {
        id: newId('wd'),
        eventId: event.id,
        endpointId: endpoint.id,
        lockedUntil: new Date(now.getTime() + DELIVERY_LEASE_MS),
      },
    });
  });
  return attemptDelivery(db, delivery.id, options);
}

/** The public JSON shape of an endpoint. The secret is never part of it. */
export function webhookEndpointResource(e: WebhookEndpoint): WebhookEndpointResponse {
  return {
    id: e.id,
    url: e.url,
    event_types: e.eventTypes,
    enabled: e.enabled,
    disabled_reason: e.disabledReason,
    created_at: e.createdAt.toISOString(),
  };
}
