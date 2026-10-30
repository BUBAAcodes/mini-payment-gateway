const DEFAULT_PATH = '/dashboard';

/**
 * Where to go after logging in. `next` comes from the URL, so anyone can set it: only a plain path
 * on this site is allowed. "//evil.example" and "/\evil.example" are other sites to a browser.
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== 'string') return DEFAULT_PATH;
  // A visible-ASCII path that starts with exactly one slash.
  if (!/^\/(?![/\\])[\x21-\x7e]*$/.test(next)) return DEFAULT_PATH;
  return next;
}
