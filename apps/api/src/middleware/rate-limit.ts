import type { RequestHandler, Response } from 'express';
import type { Redis } from 'ioredis';
import { RateLimitedError } from '@gateway/shared';

// Rate limiting per API key (section 12), a fixed window: each key may make `limit` requests per
// minute, counted in Redis with INCR + EXPIRE. Every minute has its own counter key, so if an
// EXPIRE is ever lost, only that minute's key lingers; the next minute starts from zero anyway.
// If Redis is down or slow, requests go through (decision 0003).

/** Where the counts live. Redis in production; tests can use createMemoryStore(). */
export interface RateLimitStore {
  /** Adds one hit to `key` and returns the count so far. The key expires ttlSeconds after its first hit. */
  hit(key: string, ttlSeconds: number): Promise<number>;
}

/**
 * INCR, then EXPIRE on the first hit only, so a busy key costs one command per request. Upstash's
 * free tier counts commands. Uses nothing beyond INCR and EXPIRE, so your own MiniRedis can serve it.
 */
export function createRedisStore(redis: Redis): RateLimitStore {
  return {
    async hit(key, ttlSeconds) {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, ttlSeconds);
      return count;
    },
  };
}

/** An in-process store for tests. Same behaviour as Redis, but per process and never shared. */
export function createMemoryStore(now: () => number = Date.now): RateLimitStore {
  const counts = new Map<string, { count: number; expiresAt: number }>();
  return {
    async hit(key, ttlSeconds) {
      const entry = counts.get(key);
      if (entry && entry.expiresAt > now()) {
        entry.count += 1;
        return entry.count;
      }
      counts.set(key, { count: 1, expiresAt: now() + ttlSeconds * 1000 });
      return 1;
    },
  };
}

/** Which fixed window `nowMs` falls in, and how many whole seconds (rounded up) are left in it. */
export function fixedWindow(nowMs: number, windowMs: number): { id: number; secondsLeft: number } {
  const id = Math.floor(nowMs / windowMs);
  return { id, secondsLeft: Math.ceil(((id + 1) * windowMs - nowMs) / 1000) };
}

export interface RateLimitOptions {
  store: RateLimitStore;
  /** Requests per key per window: RATE_LIMIT_PER_MINUTE. */
  limit: number;
  windowMs?: number;
  /** The limiter's clock, in milliseconds. Tests pass their own. */
  now?: () => number;
}

/**
 * Limits each API key to `limit` requests per window. Goes after requireApiKey and before any
 * route, so a request over the limit never reaches a handler: it creates nothing and stores no
 * idempotency key. Sets RateLimit-Limit, -Remaining and -Reset on every response it counts, and
 * Retry-After on a 429.
 */
export function rateLimitPerApiKey({
  store,
  limit,
  windowMs = 60_000,
  now = Date.now,
}: RateLimitOptions): RequestHandler {
  const ttlSeconds = Math.ceil(windowMs / 1000);
  return async (req, res, next) => {
    const window = fixedWindow(now(), windowMs);
    let count: number;
    try {
      count = await store.hit(`rl:${apiKeyIdOf(res)}:${window.id}`, ttlSeconds);
    } catch (err) {
      // Fail open: a Redis outage must not stop merchants taking payments.
      req.log.warn({ err }, 'rate limiter unavailable; request not counted');
      next();
      return;
    }

    res.set({
      'RateLimit-Limit': String(limit),
      'RateLimit-Remaining': String(Math.max(0, limit - count)),
      'RateLimit-Reset': String(window.secondsLeft),
    });
    if (count > limit) {
      res.set('Retry-After', String(window.secondsLeft));
      throw new RateLimitedError(
        `Rate limit of ${limit} requests per minute exceeded. Retry in ${window.secondsLeft} s.`,
      );
    }
    next();
  };
}

function apiKeyIdOf(res: Response): string {
  const apiKeyId: unknown = res.locals.apiKeyId;
  if (typeof apiKeyId !== 'string') {
    throw new Error('rateLimitPerApiKey() used on a route without requireApiKey');
  }
  return apiKeyId;
}
