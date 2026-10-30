import { describe, expect, it } from 'vitest';
import { safeNextPath } from './redirects';

describe('safeNextPath', () => {
  it('keeps a path on this site, with its query', () => {
    expect(safeNextPath('/dashboard')).toBe('/dashboard');
    expect(safeNextPath('/dashboard/payments?status=captured')).toBe(
      '/dashboard/payments?status=captured',
    );
  });

  it.each([
    ['nothing', undefined],
    ['an empty string', ''],
    ['not a string', 42],
    ['an absolute URL', 'https://evil.example/dashboard'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash trick', '/\\evil.example'],
    ['a relative path', 'dashboard'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a control character', '/dashboard\n'],
  ])('falls back to /dashboard for %s', (_name, value) => {
    expect(safeNextPath(value)).toBe('/dashboard');
  });
});
