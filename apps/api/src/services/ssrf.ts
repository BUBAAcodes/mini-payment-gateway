import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { ValidationError } from '@gateway/shared';

// SSRF protection (spec section 11). A webhook URL is chosen by the merchant, and our server calls
// it. Without these checks a merchant could make us call our own database, Redis or the cloud
// metadata service (169.254.169.254) and read the answer from the delivery log.

const blocked = new BlockList();
blocked.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"; 0.0.0.0 reaches localhost on Linux
blocked.addSubnet('10.0.0.0', 8, 'ipv4');
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('172.16.0.0', 12, 'ipv4');
blocked.addSubnet('192.168.0.0', 16, 'ipv4');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');

const MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/** "::ffff:7f00:1" and "::ffff:127.0.0.1" are IPv4 addresses in IPv6 clothing: unwrap them. */
function unwrapMappedIpv4(ip: string): string | null {
  const dotted = MAPPED_DOTTED.exec(ip);
  if (dotted) return dotted[1]!;
  const hex = MAPPED_HEX.exec(ip);
  if (!hex) return null;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** True for private, loopback, link-local and unspecified addresses. Anything unparsable is blocked. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = unwrapMappedIpv4(ip);
  if (mapped) return isPrivateAddress(mapped);
  const version = isIP(ip);
  if (version === 0) return true;
  return blocked.check(ip, version === 4 ? 'ipv4' : 'ipv6');
}

/** Resolves a hostname to every address it has. Tests swap in a fake. */
export type ResolveAll = (hostname: string) => Promise<LookupAddress[]>;

const resolveAll: ResolveAll = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    );
  });

export interface UrlCheckOptions {
  /** ALLOW_PRIVATE_WEBHOOK_URLS: true locally, so webhooks can reach Docker services. */
  allowPrivate: boolean;
  resolve?: ResolveAll;
}

const PRIVATE_MESSAGE = 'Webhook URL must not point to a private, loopback or link-local address';

/**
 * Why we must not call this URL, or null if it's fine. Resolves the hostname, so call it when the
 * URL is saved and again before each send: DNS can change in between.
 */
export async function checkWebhookUrl(
  rawUrl: string,
  { allowPrivate, resolve = resolveAll }: UrlCheckOptions,
): Promise<string | null> {
  const url = URL.parse(rawUrl);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return 'Webhook URL must use http or https';
  }
  if (allowPrivate) return null;

  // IPv6 hostnames come wrapped in brackets: http://[::1]/.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await resolve(host)).map((a) => a.address);
    } catch {
      return `Webhook URL host ${host} could not be resolved`;
    }
  }
  // One private address is enough to refuse: the connection could pick any of them.
  return addresses.length === 0 || addresses.some(isPrivateAddress) ? PRIVATE_MESSAGE : null;
}

/** checkWebhookUrl as a 400 on the `url` field, for create requests. */
export async function assertWebhookUrlAllowed(
  rawUrl: string,
  options: UrlCheckOptions,
): Promise<void> {
  const problem = await checkWebhookUrl(rawUrl, options);
  if (problem) throw new ValidationError(problem, 'url');
}

/**
 * A `lookup` for http.request that refuses private addresses. Checking the URL first and then
 * connecting leaves a gap: DNS could answer "public" to the check and "private" to the connection
 * (DNS rebinding). This checks the very address the socket connects to. IP-literal hosts skip
 * lookup entirely, so checkWebhookUrl must still run before each send.
 */
export function guardedLookup(
  lookup: LookupFunction = dnsLookup as LookupFunction,
): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err, address, family);
      const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
      if (addresses.some(isPrivateAddress)) {
        return callback(
          Object.assign(new Error(PRIVATE_MESSAGE), { code: 'EBLOCKED' }),
          address,
          family,
        );
      }
      callback(null, address, family);
    });
  };
}
