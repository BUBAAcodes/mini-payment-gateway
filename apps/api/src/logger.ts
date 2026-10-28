import { pino, type Logger, type LevelWithSilent } from 'pino';

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

export function createLogger(level: LevelWithSilent = 'info'): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });
}
