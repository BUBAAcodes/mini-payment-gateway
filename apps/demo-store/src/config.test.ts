import { describe, expect, it } from 'vitest';
import { generateCheckoutSecret, generateWebhookSecret } from '@gateway/shared';
import { loadConfig } from './config';

const validEnv = {
  GATEWAY_SECRET_KEY: 'sk_test_0123456789abcdefghijklmnopqrstuv',
  GATEWAY_WEBHOOK_SECRET: generateWebhookSecret(),
  GATEWAY_CHECKOUT_SECRET: generateCheckoutSecret(),
};

describe('loadConfig', () => {
  it('defaults to the local API and store URLs on port 3001', () => {
    const config = loadConfig(validEnv);
    expect(config.PORT).toBe(3001);
    expect(config.API_BASE_URL).toBe('http://localhost:4000');
    expect(config.STORE_BASE_URL).toBe('http://localhost:3001');
  });

  it.each(['GATEWAY_SECRET_KEY', 'GATEWAY_WEBHOOK_SECRET', 'GATEWAY_CHECKOUT_SECRET'] as const)(
    'fails at startup without %s and says where to get it',
    (name) => {
      const env: Record<string, string> = { ...validEnv };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(new RegExp(`${name}: .*pnpm db:seed`));
    },
  );

  it('treats an empty secret as missing (docker-compose passes unset ones as "")', () => {
    expect(() => loadConfig({ ...validEnv, GATEWAY_SECRET_KEY: '' })).toThrow(/GATEWAY_SECRET_KEY/);
  });

  it('rejects secrets in the wrong format without printing them', () => {
    const wrongKey = 'pk_live_not_a_test_key';
    expect(() => loadConfig({ ...validEnv, GATEWAY_SECRET_KEY: wrongKey })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(wrongKey) }),
    );
    expect(() => loadConfig({ ...validEnv, GATEWAY_WEBHOOK_SECRET: 'abc' })).toThrow(
      /GATEWAY_WEBHOOK_SECRET/,
    );
  });

  it('rejects URLs that are not http(s)', () => {
    expect(() => loadConfig({ ...validEnv, API_BASE_URL: 'api:4000' })).toThrow(/API_BASE_URL/);
    expect(() => loadConfig({ ...validEnv, STORE_BASE_URL: 'ftp://store' })).toThrow(
      /STORE_BASE_URL/,
    );
  });

  it('drops a trailing slash from STORE_BASE_URL so callback URLs have no "//"', () => {
    expect(loadConfig({ ...validEnv, STORE_BASE_URL: 'http://shop.test/' }).STORE_BASE_URL).toBe(
      'http://shop.test',
    );
  });
});
