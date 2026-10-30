import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pino, type LevelWithSilent, type Logger } from 'pino';

/** Logs to stdout. The API key travels in our outgoing calls only, but never log it if it leaks. */
export function createLogger(level: LevelWithSilent = 'info'): Logger {
  return pino({
    level,
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' },
  });
}

// Accept caller IDs only if they're short and plain, so they can't inject junk into logs.
const SAFE_REQUEST_ID = /^[\w-]{1,128}$/;

/**
 * Reuses the caller's X-Request-Id or makes a new one (pino-http's genReqId). The store passes it
 * on to the gateway, so one purchase can be followed through both apps' logs.
 */
export function assignRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}
