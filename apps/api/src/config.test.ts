import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const validEnv = {
  DATABASE_URL: 'postgresql://gateway:gateway@localhost:5432/gateway',
  APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

describe('loadConfig', () => {
  it('accepts a 32-byte base64 encryption key', () => {
    expect(loadConfig(validEnv).APP_ENCRYPTION_KEY).toBe(validEnv.APP_ENCRYPTION_KEY);
  });

  it('fails at startup when APP_ENCRYPTION_KEY is missing', () => {
    const { APP_ENCRYPTION_KEY: _, ...env } = validEnv;
    expect(() => loadConfig(env)).toThrow(/APP_ENCRYPTION_KEY/);
  });

  it.each([
    ['empty', ''],
    ['16 bytes', randomBytes(16).toString('base64')],
    ['not base64 of 32 bytes', 'not-a-key'],
  ])('rejects an APP_ENCRYPTION_KEY that is %s', (_name, value) => {
    expect(() => loadConfig({ ...validEnv, APP_ENCRYPTION_KEY: value })).toThrow(
      /APP_ENCRYPTION_KEY: .*32 random bytes/,
    );
  });

  it('never prints the key in the error', () => {
    const value = randomBytes(16).toString('base64');
    expect(() => loadConfig({ ...validEnv, APP_ENCRYPTION_KEY: value })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(value) }),
    );
  });

  it('defaults WEB_BASE_URL to the local web app', () => {
    expect(loadConfig(validEnv).WEB_BASE_URL).toBe('http://localhost:3000');
  });

  it('accepts an http(s) WEB_BASE_URL and rejects anything else', () => {
    const url = 'https://web.example';
    expect(loadConfig({ ...validEnv, WEB_BASE_URL: url }).WEB_BASE_URL).toBe(url);
    expect(() => loadConfig({ ...validEnv, WEB_BASE_URL: 'web.example' })).toThrow(/WEB_BASE_URL/);
    expect(() => loadConfig({ ...validEnv, WEB_BASE_URL: 'ftp://web.example' })).toThrow(
      /WEB_BASE_URL/,
    );
  });

  it('defaults the fake bank delay to longer than our bank timeout', () => {
    const config = loadConfig(validEnv);
    expect(config.BANK_SLOW_MS).toBe(20_000);
    expect(config.BANK_TIMEOUT_MS).toBe(10_000);
  });

  it('reads bank timings from strings and rejects nonsense', () => {
    expect(loadConfig({ ...validEnv, BANK_SLOW_MS: '500' }).BANK_SLOW_MS).toBe(500);
    expect(() => loadConfig({ ...validEnv, BANK_TIMEOUT_MS: '-1' })).toThrow(/BANK_TIMEOUT_MS/);
    expect(() => loadConfig({ ...validEnv, BANK_SLOW_MS: 'soon' })).toThrow(/BANK_SLOW_MS/);
  });

  it('defaults FEE_BPS to 200 (2%)', () => {
    expect(loadConfig(validEnv).FEE_BPS).toBe(200);
  });

  it('reads FEE_BPS as whole basis points from 0 to 10000', () => {
    expect(loadConfig({ ...validEnv, FEE_BPS: '150' }).FEE_BPS).toBe(150);
    expect(loadConfig({ ...validEnv, FEE_BPS: '0' }).FEE_BPS).toBe(0);
    for (const bad of ['-1', '10001', '1.5', 'two']) {
      expect(() => loadConfig({ ...validEnv, FEE_BPS: bad })).toThrow(/FEE_BPS/);
    }
  });

  it('blocks private webhook URLs unless told otherwise', () => {
    expect(loadConfig(validEnv).ALLOW_PRIVATE_WEBHOOK_URLS).toBe(false);
    expect(
      loadConfig({ ...validEnv, ALLOW_PRIVATE_WEBHOOK_URLS: 'true' }).ALLOW_PRIVATE_WEBHOOK_URLS,
    ).toBe(true);
    // z.coerce.boolean() would read "false" as true.
    expect(
      loadConfig({ ...validEnv, ALLOW_PRIVATE_WEBHOOK_URLS: 'false' }).ALLOW_PRIVATE_WEBHOOK_URLS,
    ).toBe(false);
    expect(() => loadConfig({ ...validEnv, ALLOW_PRIVATE_WEBHOOK_URLS: 'yes' })).toThrow(
      /ALLOW_PRIVATE_WEBHOOK_URLS/,
    );
  });
});
