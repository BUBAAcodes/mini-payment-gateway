import { Redis } from 'ioredis';
import type { Logger } from 'pino';

/**
 * The Redis client for rate limiting. Set up to fail fast rather than wait, because the limiter
 * lets requests through when Redis is unavailable (decision 0003): while disconnected, commands
 * fail at once instead of queueing, and a connected but stuck Redis times out after 500 ms. It
 * keeps reconnecting in the background.
 */
export function createRedisClient(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    connectTimeout: 5_000,
    // Skips the INFO command on connect, which a minimal Redis (your own MiniRedis) may not have.
    enableReadyCheck: false,
  });
  // Without a listener, connection errors would be thrown as unhandled 'error' events.
  redis.on('error', (err) => logger.warn({ err }, 'redis error'));
  return redis;
}
