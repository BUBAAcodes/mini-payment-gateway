import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@gateway/shared';
import {
  assertWebhookUrlAllowed,
  checkWebhookUrl,
  guardedLookup,
  isPrivateAddress,
  type ResolveAll,
} from './ssrf';

describe('isPrivateAddress', () => {
  it.each([
    '10.0.0.5',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '127.0.0.1',
    '127.10.0.1',
    '169.254.169.254', // cloud metadata service
    '0.0.0.0',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1', // the same address, written in hex
    '::ffff:a9fe:a9fe', // 169.254.169.254
  ])('blocks %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    '93.184.215.14',
    '8.8.8.8',
    '172.32.0.1',
    '192.169.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

/** A resolver that answers from a fixed table instead of DNS. */
function fakeResolver(table: Record<string, string[]>): ResolveAll {
  return async (hostname) => {
    const addresses = table[hostname];
    if (!addresses)
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

describe('checkWebhookUrl', () => {
  const resolve = fakeResolver({
    'merchant.example': ['93.184.215.14'],
    'internal.example': ['10.1.2.3'],
    'mixed.example': ['93.184.215.14', '192.168.0.10'],
  });
  const blocked = { allowPrivate: false, resolve };

  it('allows a public hostname and a public IP', async () => {
    expect(await checkWebhookUrl('https://merchant.example/hooks', blocked)).toBeNull();
    expect(await checkWebhookUrl('http://93.184.215.14:8080/hooks', blocked)).toBeNull();
  });

  it.each([
    'ftp://merchant.example/hooks',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s: http and https only', async (url) => {
    expect(await checkWebhookUrl(url, blocked)).toMatch(/http or https/);
  });

  it.each([
    'http://127.0.0.1/hooks',
    'http://10.0.0.5',
    'http://[::1]:3000/',
    'http://[::ffff:127.0.0.1]/',
  ])('rejects the private IP literal %s', async (url) => {
    expect(await checkWebhookUrl(url, blocked)).toMatch(/private/);
  });

  it('rejects a hostname that resolves to a private address', async () => {
    expect(await checkWebhookUrl('https://internal.example/hooks', blocked)).toMatch(/private/);
  });

  it('rejects a hostname if any of its addresses is private', async () => {
    expect(await checkWebhookUrl('https://mixed.example/hooks', blocked)).toMatch(/private/);
  });

  it('rejects a hostname that does not resolve', async () => {
    expect(await checkWebhookUrl('https://nowhere.example/hooks', blocked)).toMatch(/resolve/);
  });

  it('allows private addresses when ALLOW_PRIVATE_WEBHOOK_URLS is on, but still checks the scheme', async () => {
    const allowed = { allowPrivate: true, resolve };
    expect(await checkWebhookUrl('http://127.0.0.1:3001/webhooks', allowed)).toBeNull();
    expect(await checkWebhookUrl('https://internal.example/hooks', allowed)).toBeNull();
    expect(await checkWebhookUrl('ftp://internal.example/hooks', allowed)).toMatch(/http or https/);
  });
});

describe('assertWebhookUrlAllowed', () => {
  it('throws a validation error on the url field', async () => {
    const error = await assertWebhookUrlAllowed('http://10.0.0.5', { allowPrivate: false }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ field: 'url', status: 400 });
  });
});

describe('guardedLookup', () => {
  type Answer = {
    err: NodeJS.ErrnoException | null;
    address: string | LookupAddress[];
    family?: number;
  };

  /** Calls the guarded lookup the way net.connect does, with a fake resolver underneath. */
  function lookupWith(answer: LookupAddress[], all: boolean): Promise<Answer> {
    const lookup = guardedLookup((_hostname, _options, callback) => {
      if (all) callback(null, answer);
      else callback(null, answer[0]!.address, answer[0]!.family);
    });
    return new Promise((resolve) => {
      lookup('rebinding.example', { all }, (err, address, family) =>
        resolve({ err, address, family }),
      );
    });
  }

  it.each([true, false])('passes public addresses through (all: %s)', async (all) => {
    const answer = await lookupWith([{ address: '93.184.215.14', family: 4 }], all);
    expect(answer.err).toBeNull();
  });

  it.each([true, false])(
    'fails the connection when DNS now points somewhere private (all: %s)',
    async (all) => {
      const answer = await lookupWith([{ address: '169.254.169.254', family: 4 }], all);
      expect(answer.err?.message).toMatch(/private/);
    },
  );
});
