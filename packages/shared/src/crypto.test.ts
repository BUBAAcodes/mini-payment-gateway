import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, isValidEncryptionKey } from './crypto';

const key = randomBytes(32).toString('base64');
const otherKey = randomBytes(32).toString('base64');

/** Flips one bit in the base64 part at `index` of a "v1:iv:tag:ciphertext" blob. */
function tamper(blob: string, index: 1 | 2 | 3): string {
  const parts = blob.split(':');
  const bytes = Buffer.from(parts[index]!, 'base64');
  bytes[0]! ^= 0x01;
  parts[index] = bytes.toString('base64');
  return parts.join(':');
}

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret', () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });

  it('round-trips unicode and the empty string', () => {
    expect(decryptSecret(encryptSecret('₹ secret', key), key)).toBe('₹ secret');
    expect(decryptSecret(encryptSecret('', key), key)).toBe('');
  });

  it('stores v1:iv:tag:ciphertext and never the plaintext', () => {
    const blob = encryptSecret('my-secret', key);
    const [version, iv, tag, ciphertext] = blob.split(':');
    expect(version).toBe('v1');
    expect(Buffer.from(iv!, 'base64')).toHaveLength(12);
    expect(Buffer.from(tag!, 'base64')).toHaveLength(16);
    expect(ciphertext).toBeTruthy();
    expect(blob).not.toContain('my-secret');
  });

  it('uses a fresh IV each time, so equal secrets encrypt differently', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('rejects a tampered ciphertext, auth tag or IV', () => {
    const blob = encryptSecret('my-secret', key);
    expect(() => decryptSecret(tamper(blob, 3), key)).toThrow();
    expect(() => decryptSecret(tamper(blob, 2), key)).toThrow();
    expect(() => decryptSecret(tamper(blob, 1), key)).toThrow();
  });

  it('rejects the wrong key', () => {
    expect(() => decryptSecret(encryptSecret('my-secret', key), otherKey)).toThrow();
  });

  it('rejects a key that is not 32 bytes', () => {
    const shortKey = randomBytes(16).toString('base64');
    expect(() => encryptSecret('x', shortKey)).toThrow(/32 bytes/);
    expect(() => decryptSecret(encryptSecret('x', key), shortKey)).toThrow(/32 bytes/);
    expect(() => encryptSecret('x', '')).toThrow(/32 bytes/);
  });

  it('rejects a malformed blob', () => {
    expect(() => decryptSecret('not-encrypted', key)).toThrow(/format/);
    expect(() => decryptSecret('v2:a:b:c', key)).toThrow(/format/);
    const [, iv, tag, ciphertext] = encryptSecret('x', key).split(':');
    expect(() => decryptSecret(`v1:${iv}:${tag}`, key)).toThrow(/format/);
    expect(() => decryptSecret(`v1:${iv}:AAAA:${ciphertext}`, key)).toThrow();
  });
});

describe('isValidEncryptionKey', () => {
  it('accepts 32 bytes, base64-encoded', () => {
    expect(isValidEncryptionKey(key)).toBe(true);
  });

  it('rejects empty, short and long keys', () => {
    expect(isValidEncryptionKey('')).toBe(false);
    expect(isValidEncryptionKey(randomBytes(16).toString('base64'))).toBe(false);
    expect(isValidEncryptionKey(randomBytes(33).toString('base64'))).toBe(false);
  });
});
