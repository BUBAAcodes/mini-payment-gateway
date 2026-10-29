import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateApiKey,
  generateCheckoutSecret,
  generateClientSecret,
  generateWebhookSecret,
  sha256Hex,
} from './secrets';

describe('sha256Hex', () => {
  it('matches a known SHA-256 digest', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('generateApiKey', () => {
  it('is sk_test_ plus 32 base62 characters', () => {
    expect(generateApiKey().key).toMatch(/^sk_test_[0-9A-Za-z]{32}$/);
  });

  it('stores the first 12 characters as the prefix', () => {
    const { key, prefix } = generateApiKey();
    expect(prefix).toHaveLength(12);
    expect(key.startsWith(prefix)).toBe(true);
  });

  it('stores the SHA-256 of the full key, never the key itself', () => {
    const { key, hash } = generateApiKey();
    expect(hash).toBe(createHash('sha256').update(key).digest('hex'));
    expect(hash).not.toContain(key);
  });

  it('does not repeat', () => {
    const keys = new Set(Array.from({ length: 1_000 }, () => generateApiKey().key));
    expect(keys.size).toBe(1_000);
  });
});

describe('generateClientSecret', () => {
  it('is cs_ plus 24 base62 characters', () => {
    expect(generateClientSecret()).toMatch(/^cs_[0-9A-Za-z]{24}$/);
  });
});

describe('generateWebhookSecret', () => {
  it('is whsec_ plus the base64 of 32 random bytes (Standard Webhooks)', () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(secret.slice('whsec_'.length), 'base64')).toHaveLength(32);
  });
});

describe('generateCheckoutSecret', () => {
  it('encodes 32 random bytes', () => {
    const secret = generateCheckoutSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(generateCheckoutSecret()).not.toBe(secret);
  });
});
