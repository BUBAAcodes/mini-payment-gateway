import { pino, type DestinationStream, type Logger, type LevelWithSilent } from 'pino';

// Never log credentials, card data or OTPs (spec section 12). Paths are relative to the log object.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.card_number',
  '*.cvv',
  '*.otp',
  '*.secret',
  '*.client_secret',
];

const REDACTED = '[redacted]';

/** Logs to stdout, or to `destination` (tests use it to read what was logged). */
export function createLogger(
  level: LevelWithSilent = 'info',
  destination?: DestinationStream,
): Logger {
  const options = { level, redact: { paths: REDACT_PATHS, censor: REDACTED } };
  return destination ? pino(options, destination) : pino(options);
}

/**
 * Hides the checkout client secret from a logged request. Checkout routes carry it in ?cs=, and
 * pino-http logs both the URL and the parsed query. Use it as pino-http's `req` serializer: it gets
 * pino's copy of the request, so changing it leaves the real request alone.
 */
export function redactCheckoutSecret<T extends { url?: string; query?: unknown }>(req: T): T {
  if (typeof req.url === 'string') {
    req.url = req.url.replace(/([?&]cs=)[^&#]*/g, `$1${REDACTED}`);
  }
  if (typeof req.query === 'object' && req.query !== null && 'cs' in req.query) {
    req.query = { ...req.query, cs: REDACTED };
  }
  return req;
}
