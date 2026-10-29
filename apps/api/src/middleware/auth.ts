import type { RequestHandler, Response } from 'express';
import type { PrismaClient } from '@gateway/db';
import { UnauthorizedError } from '@gateway/shared';
import { authenticateApiKey } from '../services/api-keys';

const BEARER = /^Bearer (\S+)$/;

/**
 * Requires `Authorization: Bearer sk_test_...`. Every failure (missing, malformed, unknown,
 * wrong or revoked) gets the same 401, so callers can't tell which part was wrong.
 */
export function requireApiKey(db: PrismaClient): RequestHandler {
  return async (req, res, next) => {
    const rawKey = BEARER.exec(req.headers.authorization ?? '')?.[1];
    const identity = rawKey ? await authenticateApiKey(db, rawKey) : null;
    if (!identity) throw new UnauthorizedError();

    res.locals.merchantId = identity.merchantId;
    req.log = req.log.child({ merchant_id: identity.merchantId, api_key_id: identity.apiKeyId });
    next();
  };
}

/** The authenticated merchant. Every merchant-owned query must filter by it. */
export function merchantIdOf(res: Response): string {
  const merchantId: unknown = res.locals.merchantId;
  if (typeof merchantId !== 'string') {
    throw new Error('merchantIdOf() used on a route without requireApiKey');
  }
  return merchantId;
}
