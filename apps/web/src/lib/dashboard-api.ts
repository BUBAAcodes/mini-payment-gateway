import 'server-only';
import type { BalanceResponse, MerchantResponse } from '@gateway/shared';
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

export function getMerchant(merchantId: string) {
  return callDashboardApi<MerchantResponse>(merchantId, '/dashboard/merchant');
}

export function getBalance(merchantId: string) {
  return callDashboardApi<BalanceResponse>(merchantId, '/dashboard/balance');
}
