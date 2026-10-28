import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'X-Request-Id';

// Accept caller IDs only if they're short and plain, so they can't inject junk into logs.
const SAFE_REQUEST_ID = /^[\w-]{1,128}$/;

/**
 * Reuses the caller's X-Request-Id or makes a new one, and returns it on the response.
 * Used as pino-http's genReqId, so `req.id` and every `req.log` line carry the same ID.
 */
export function assignRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}
