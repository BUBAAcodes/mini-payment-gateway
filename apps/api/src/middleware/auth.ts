import type { RequestHandler, Response } from 'express';
import type { PrismaClient } from '@gateway/db';
import { UnauthorizedError, constantTimeEqual, isId } from '@gateway/shared';
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
    res.locals.apiKeyId = identity.apiKeyId;
    req.log = req.log.child({ merchant_id: identity.merchantId, api_key_id: identity.apiKeyId });
    next();
  };
}

/**
 * For /dashboard/*: requires `Authorization: Bearer <DASHBOARD_SERVICE_TOKEN>` and
 * `X-Merchant-Id`. Only the web app's server holds the token, and it takes the merchant ID from
 * the logged-in session, never from the browser. Every failure gets the same 401.
 */
export function requireDashboardService(db: PrismaClient, token: string): RequestHandler {
  return async (req, res, next) => {
    const sent = BEARER.exec(req.headers.authorization ?? '')?.[1];
    const merchantId = req.get('x-merchant-id');
    const allowed =
      sent !== undefined &&
      constantTimeEqual(sent, token) &&
      merchantId !== undefined &&
      isId('mer', merchantId) &&
      (await db.merchant.count({ where: { id: merchantId } })) === 1;
    if (!allowed) throw new UnauthorizedError('Invalid or missing dashboard credentials');

    res.locals.merchantId = merchantId;
    req.log = req.log.child({ merchant_id: merchantId, via: 'dashboard' });
    next();
  };
}

/** The authenticated merchant. Every merchant-owned query must filter by it. */
export function merchantIdOf(res: Response): string {
  const merchantId: unknown = res.locals.merchantId;
  if (typeof merchantId !== 'string') {
    throw new Error(
      'merchantIdOf() used on a route without requireApiKey or requireDashboardService',
    );
  }
  return merchantId;
}

/**
 * Requires `Authorization: Bearer <secret>`, for the internal routes the daily cron calls. Compared
 * in constant time; every failure gets the same 401.
 */
export function requireBearerSecret(secret: string): RequestHandler {
  return (req, _res, next) => {
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !constantTimeEqual(token, secret)) {
      throw new UnauthorizedError('Invalid or missing token');
    }
    next();
  };
}
