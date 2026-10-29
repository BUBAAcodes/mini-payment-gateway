import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM for secrets we must read back later (webhook and checkout signing secrets).
// GCM authenticates as well as encrypts: a changed byte anywhere makes decryption throw.
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 'v1';

function parseKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new RangeError(`Encryption key must be ${KEY_BYTES} bytes, base64-encoded`);
  }
  return key;
}

/** True if the value is 32 bytes, base64-encoded: a usable APP_ENCRYPTION_KEY. */
export function isValidEncryptionKey(keyB64: string): boolean {
  return Buffer.from(keyB64, 'base64').length === KEY_BYTES;
}

/** Encrypts with a random IV. Returns "v1:<iv>:<tag>:<ciphertext>", each part base64. */
export function encryptSecret(plaintext: string, keyB64: string): string {
  const key = parseKey(keyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv, tag, ciphertext].map((p) => p.toString('base64')).join(':');
}

/** Reverses encryptSecret. Throws if the blob was tampered with or the key is wrong. */
export function decryptSecret(blob: string, keyB64: string): string {
  const key = parseKey(keyB64);
  const [version, ivB64, tagB64, ciphertextB64, ...rest] = blob.split(':');
  if (
    version !== FORMAT_VERSION ||
    ivB64 === undefined ||
    tagB64 === undefined ||
    ciphertextB64 === undefined ||
    rest.length > 0
  ) {
    throw new Error('Unrecognised encrypted secret format');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Unrecognised encrypted secret format');
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
