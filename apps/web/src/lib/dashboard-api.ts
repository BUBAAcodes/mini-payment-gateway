import 'server-only';
import type {
  ApiKeyResponse,
  BalanceResponse,
  CreatedApiKeyResponse,
  CreateWebhookEndpointInput,
  DashboardOverviewResponse,
  EventResponse,
  MerchantResponse,
  PaymentActivityResponse,
  PaymentResponse,
  ReconciliationIssueResponse,
  RefundResponse,
  SettlementResponse,
  WebhookDeliveryResponse,
  WebhookEndpointResponse,
} from '@gateway/shared';
import { apiUrl, callApi } from './api-client';
import type { ApiResult } from './checkout';

// The dashboard API (/dashboard/*), called only from Next.js server code. Every call carries
// DASHBOARD_SERVICE_TOKEN and the merchant ID. Callers must take that ID from requireMerchant()
// (the logged-in session), never from a URL, form field or anything else the browser sends.

// Refunds wait for the bank for up to BANK_TIMEOUT_MS (10 s), so wait longer.
const REQUEST_TIMEOUT_MS = 15_000;

export interface DashboardRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** Required by the API on refunds. One per user action, so a retried submit can't refund twice. */
  idempotencyKey?: string;
}

export async function callDashboardApi<T>(
  merchantId: string,
  path: string,
  { method = 'GET', body, idempotencyKey }: DashboardRequest = {},
): Promise<ApiResult<T>> {
  const token = process.env.DASHBOARD_SERVICE_TOKEN;
  if (!token) throw new Error('DASHBOARD_SERVICE_TOKEN is not set');

  return callApi<T>({
    method,
    url: apiUrl(path),
    headers: {
      authorization: `Bearer ${token}`,
      'x-merchant-id': merchantId,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}

/** One page of a list: `{ data, has_more }`. */
export interface Page<T> {
  data: T[];
  has_more: boolean;
}

export interface PageQuery {
  limit?: number;
  /** The last ID on the previous page. */
  starting_after?: string;
}

/** IDs come from links and forms, so escape them: "../api_keys" must not reach another route. */
const segment = encodeURIComponent;

/** `path?limit=…&…`, leaving out filters that are unset or empty. */
function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(name, String(value));
  }
  return `${path}?${params}`;
}

function pageQuery({ limit = 20, starting_after }: PageQuery) {
  return { limit, starting_after };
}

// ---------- Merchant and overview ----------

export function getMerchant(merchantId: string) {
  return callDashboardApi<MerchantResponse>(merchantId, '/dashboard/merchant');
}

export function getBalance(merchantId: string) {
  return callDashboardApi<BalanceResponse>(merchantId, '/dashboard/balance');
}

export function getOverview(merchantId: string) {
  return callDashboardApi<DashboardOverviewResponse>(merchantId, '/dashboard/overview');
}

// ---------- Payments and refunds ----------

export interface PaymentFilters extends PageQuery {
  status?: PaymentResponse['status'];
  /** ISO timestamps: payments created in [from, to). */
  from?: string;
  to?: string;
}

export function listPayments(merchantId: string, { status, from, to, ...page }: PaymentFilters) {
  return callDashboardApi<Page<PaymentResponse>>(
    merchantId,
    withQuery('/dashboard/payments', { ...pageQuery(page), status, from, to }),
  );
}

export function getPayment(merchantId: string, paymentId: string) {
  return callDashboardApi<PaymentResponse>(merchantId, `/dashboard/payments/${segment(paymentId)}`);
}

/** The payment's refunds and the webhook events about it. */
export function getPaymentActivity(merchantId: string, paymentId: string) {
  return callDashboardApi<PaymentActivityResponse>(
    merchantId,
    `/dashboard/payments/${segment(paymentId)}/activity`,
  );
}

/** No amount refunds whatever is left. The key makes a repeated submit a replay, not a 2nd refund. */
export function createRefund(
  merchantId: string,
  paymentId: string,
  input: { amount?: number },
  idempotencyKey: string,
) {
  return callDashboardApi<RefundResponse>(
    merchantId,
    `/dashboard/payments/${segment(paymentId)}/refunds`,
    { method: 'POST', body: input, idempotencyKey },
  );
}

// ---------- API keys ----------

/** A merchant has a handful of keys, so the page shows them all. */
export function listApiKeys(merchantId: string) {
  return callDashboardApi<Page<ApiKeyResponse>>(merchantId, '/dashboard/api_keys?limit=100');
}

export function createApiKey(merchantId: string) {
  return callDashboardApi<CreatedApiKeyResponse>(merchantId, '/dashboard/api_keys', {
    method: 'POST',
  });
}

export function revokeApiKey(merchantId: string, keyId: string) {
  return callDashboardApi<ApiKeyResponse>(
    merchantId,
    `/dashboard/api_keys/${segment(keyId)}/revoke`,
    { method: 'POST' },
  );
}

// ---------- Webhooks ----------

export function listWebhookEndpoints(merchantId: string) {
  return callDashboardApi<Page<WebhookEndpointResponse>>(
    merchantId,
    '/dashboard/webhook_endpoints?limit=100',
  );
}

export function createWebhookEndpoint(
  merchantId: string,
  input: CreateWebhookEndpointInput,
  idempotencyKey: string,
) {
  return callDashboardApi<WebhookEndpointResponse & { secret: string }>(
    merchantId,
    '/dashboard/webhook_endpoints',
    { method: 'POST', body: input, idempotencyKey },
  );
}

export function deleteWebhookEndpoint(merchantId: string, endpointId: string) {
  return callDashboardApi<{ id: string; deleted: true }>(
    merchantId,
    `/dashboard/webhook_endpoints/${segment(endpointId)}`,
    { method: 'DELETE' },
  );
}

export function testWebhookEndpoint(merchantId: string, endpointId: string) {
  return callDashboardApi<WebhookDeliveryResponse>(
    merchantId,
    `/dashboard/webhook_endpoints/${segment(endpointId)}/test`,
    { method: 'POST' },
  );
}

export interface EventFilters extends PageQuery {
  type?: EventResponse['type'];
  /** Only events with at least one delivery in this state. */
  delivery_status?: WebhookDeliveryResponse['status'];
}

export function listEvents(merchantId: string, { type, delivery_status, ...page }: EventFilters) {
  return callDashboardApi<Page<EventResponse>>(
    merchantId,
    withQuery('/dashboard/events', { ...pageQuery(page), type, delivery_status }),
  );
}

/** Queues the event again for every live endpoint that got it before. */
export function redeliverEvent(merchantId: string, eventId: string, idempotencyKey: string) {
  return callDashboardApi<{ data: WebhookDeliveryResponse[] }>(
    merchantId,
    `/dashboard/events/${segment(eventId)}/redeliver`,
    { method: 'POST', body: {}, idempotencyKey },
  );
}

// ---------- Back office ----------

export function listSettlements(merchantId: string, page: PageQuery) {
  return callDashboardApi<Page<SettlementResponse>>(
    merchantId,
    withQuery('/dashboard/settlements', pageQuery(page)),
  );
}

export function listReconciliationIssues(
  merchantId: string,
  { status, ...page }: PageQuery & { status?: 'open' | 'resolved' },
) {
  return callDashboardApi<Page<ReconciliationIssueResponse>>(
    merchantId,
    withQuery('/dashboard/reconciliation_issues', { ...pageQuery(page), status }),
  );
}

export function resolveReconciliationIssue(merchantId: string, issueId: string) {
  return callDashboardApi<ReconciliationIssueResponse>(
    merchantId,
    `/dashboard/reconciliation_issues/${segment(issueId)}/resolve`,
    { method: 'POST' },
  );
}
