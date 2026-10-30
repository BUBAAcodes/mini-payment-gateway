import { setTimeout as sleep } from 'node:timers/promises';

// The store's side of the merchant API (section 8): what any merchant's server would call, with
// its secret API key. Only the fields the store reads are typed.

export interface CreateOrderRequest {
  amount: number;
  currency: 'INR';
  receipt: string;
  callback_url: string;
}

/** POST /v1/orders. */
export interface GatewayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt: string | null;
  client_secret: string;
  /** Where to send the customer to pay. */
  checkout_url: string;
}

/** GET /v1/payments/:id. */
export interface GatewayPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  failure_reason: string | null;
}

export interface GatewayClient {
  /** Retries are safe: every attempt sends the same idempotency key, so only one order exists. */
  createOrder(
    input: CreateOrderRequest,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<GatewayOrder>;
  /** Null if the gateway has no such payment for this merchant. */
  getPayment(id: string, requestId?: string): Promise<GatewayPayment | null>;
}

/** The gateway answered with an error, or couldn't be reached (no status). */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  /** Worth trying again with the same idempotency key: nothing we sent was wrong. */
  get retryable(): boolean {
    return (
      this.status === undefined ||
      this.status >= 500 ||
      (this.status === 409 && this.code === 'idempotency_in_progress')
    );
  }
}

export interface GatewayClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Per attempt. */
  timeoutMs?: number;
  /** Waits between attempts; one more attempt than there are delays. */
  retryDelaysMs?: number[];
}

export function createGatewayClient({
  baseUrl,
  apiKey,
  timeoutMs = 10_000,
  retryDelaysMs = [250, 1_000],
}: GatewayClientOptions): GatewayClient {
  async function call(
    method: 'GET' | 'POST',
    path: string,
    { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'failed';
      throw new GatewayError(`${method} ${path} ${reason}`);
    }
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  function errorFrom(status: number, json: unknown, what: string): GatewayError {
    const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
    return new GatewayError(
      `${what} failed with ${status}${error?.message ? `: ${error.message}` : ''}`,
      status,
      error?.code,
    );
  }

  function requestIdHeader(requestId?: string): Record<string, string> {
    return requestId ? { 'x-request-id': requestId } : {};
  }

  return {
    async createOrder(input, idempotencyKey, requestId) {
      const headers = { 'idempotency-key': idempotencyKey, ...requestIdHeader(requestId) };
      for (let attempt = 0; ; attempt++) {
        try {
          const { status, json } = await call('POST', '/v1/orders', { body: input, headers });
          if (status === 200 || status === 201) return json as GatewayOrder;
          throw errorFrom(status, json, 'Creating the order');
        } catch (err) {
          const delay = retryDelaysMs[attempt];
          if (!(err instanceof GatewayError) || !err.retryable || delay === undefined) throw err;
          await sleep(delay);
        }
      }
    },

    // No retries here: a failed re-fetch fails the webhook, and the gateway retries that.
    async getPayment(id, requestId) {
      const path = `/v1/payments/${encodeURIComponent(id)}`;
      const { status, json } = await call('GET', path, { headers: requestIdHeader(requestId) });
      if (status === 404) return null;
      if (status !== 200) throw errorFrom(status, json, 'Fetching the payment');
      return json as GatewayPayment;
    },
  };
}
