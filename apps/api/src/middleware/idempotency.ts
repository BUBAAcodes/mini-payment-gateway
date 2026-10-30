import type { Request, RequestHandler, Response } from 'express';
import type { IdempotencyKey, PrismaClient } from '@gateway/db';
import {
  AppError,
  IdempotencyInProgressError,
  IdempotencyMismatchError,
  ValidationError,
  decryptSecret,
  encryptSecret,
  sha256Hex,
  toErrorBody,
} from '@gateway/shared';
import { merchantIdOf } from './auth';

const KEY_HEADER = 'Idempotency-Key';
const REPLAYED_HEADER = 'Idempotent-Replayed';

// Visible ASCII only, so keys are safe to store, log and compare.
const VALID_KEY = /^[\x21-\x7E]{1,255}$/;

export interface HandlerResult {
  status: number;
  body: unknown;
}

/** Returns the response instead of sending it, so it can be saved before the caller sees it. */
export type IdempotentHandler = (req: Request, res: Response) => Promise<HandlerResult>;

export interface IdempotentOptions {
  /**
   * Run the handler normally when the request has no Idempotency-Key. A key that is sent is
   * still honoured (rule 2). For POSTs where the spec doesn't demand a key.
   */
  optional?: boolean;
}

/** JSON with object keys sorted at every level, so field order doesn't change the hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 of a request body, ignoring key order. */
export function requestHash(body: unknown): string {
  return sha256Hex(canonicalJson(body ?? {}));
}

/**
 * Makes a POST safe to retry (rule 2). The first request with a key claims it and runs the
 * handler; later requests with the same key get the stored response back, never a second effect.
 * Runs after auth (keys are per merchant) and validation (a bad body doesn't use up the key).
 *
 * Stored responses are encrypted, because some hold secrets shown only once (an order's
 * client_secret).
 */
export function idempotent(
  db: PrismaClient,
  encryptionKey: string,
  handler: IdempotentHandler,
  { optional = false }: IdempotentOptions = {},
): RequestHandler {
  return async (req, res) => {
    const merchantId = merchantIdOf(res);
    const key = req.get(KEY_HEADER);
    if (key === undefined && optional) {
      const result = await handler(req, res);
      res.status(result.status).json(result.body);
      return;
    }
    if (key === undefined || !VALID_KEY.test(key)) {
      throw new ValidationError(
        `${KEY_HEADER} header is required: 1 to 255 visible ASCII characters`,
        KEY_HEADER,
      );
    }
    const fingerprint = {
      method: req.method,
      path: req.baseUrl + req.path,
      requestHash: requestHash(req.body),
    };
    const where = { merchantId_key: { merchantId, key } };

    // Claim the key first: INSERT ... ON CONFLICT DO NOTHING. The primary key (merchant_id, key)
    // makes Postgres serialize racing inserts, so exactly one request wins and runs the handler.
    const { count } = await db.idempotencyKey.createMany({
      data: { merchantId, key, ...fingerprint },
      skipDuplicates: true,
    });

    if (count === 0) {
      const existing = await db.idempotencyKey.findUnique({ where });
      if (existing && !sameRequest(existing, fingerprint)) throw new IdempotencyMismatchError();
      // No row means the first request just failed and released the key: retrying will work.
      if (!existing || existing.state === 'in_progress') throw new IdempotencyInProgressError();

      const stored = storedResponse(existing, encryptionKey);
      res.status(stored.status).set(REPLAYED_HEADER, 'true').json(stored.body);
      return;
    }

    let result: HandlerResult;
    try {
      result = await handler(req, res);
    } catch (err) {
      if (!(err instanceof AppError)) {
        // An unexpected failure: the handler's work rolled back, so let a retry run it again.
        await db.idempotencyKey.delete({ where }).catch((deleteErr: unknown) => {
          req.log.error({ err: deleteErr }, 'could not release idempotency key');
        });
        throw err;
      }
      // A deliberate refusal (e.g. invalid_state) is a final answer: replay it like a success.
      result = { status: err.status, body: toErrorBody(err) };
    }

    // Saved before sending, so a retry that arrives the moment this response lands gets a replay,
    // not a 409. If this write fails, the key stays in_progress (409s until cleanup) rather than
    // risking a second order.
    await db.idempotencyKey.update({
      where,
      data: {
        state: 'completed',
        responseStatus: result.status,
        responseBody: { ciphertext: encryptSecret(JSON.stringify(result.body), encryptionKey) },
      },
    });
    res.status(result.status).json(result.body);
  };
}

function sameRequest(
  row: IdempotencyKey,
  fingerprint: { method: string; path: string; requestHash: string },
): boolean {
  return (
    row.method === fingerprint.method &&
    row.path === fingerprint.path &&
    row.requestHash === fingerprint.requestHash
  );
}

function storedResponse(row: IdempotencyKey, encryptionKey: string): HandlerResult {
  const body = row.responseBody;
  if (
    row.responseStatus === null ||
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    typeof body.ciphertext !== 'string'
  ) {
    throw new Error(`Idempotency key ${row.key} is completed but has no stored response`);
  }
  return {
    status: row.responseStatus,
    body: JSON.parse(decryptSecret(body.ciphertext, encryptionKey)),
  };
}
