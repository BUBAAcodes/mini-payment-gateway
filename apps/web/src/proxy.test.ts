import { NextRequest } from 'next/server';
import {
  getRedirectUrl,
  // The docs call it unstable_doesProxyMatch; Next.js 16.4 still ships the old name.
  unstable_doesMiddlewareMatch as doesProxyMatch,
} from 'next/experimental/testing/server';
import { describe, expect, it } from 'vitest';
import { config, proxy } from './proxy';

const BASE = 'http://localhost:3000';
// Better Auth's session cookie name. Its value is checked later, by the page, not here.
const SESSION_COOKIE = 'better-auth.session_token=abc.def';

function request(path: string, cookie?: string) {
  return new NextRequest(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
}

describe('proxy', () => {
  it('runs on the dashboard only', () => {
    for (const url of ['/dashboard', '/dashboard/payments/pay_x']) {
      expect(doesProxyMatch({ config, url }), url).toBe(true);
    }
    for (const url of ['/', '/login', '/pay/order_x', '/api/auth/sign-in/email']) {
      expect(doesProxyMatch({ config, url }), url).toBe(false);
    }
  });

  it('sends a logged-out visitor to /login, remembering where they were going', () => {
    const res = proxy(request('/dashboard/payments?status=failed'));
    const to = new URL(getRedirectUrl(res)!);
    expect(to.pathname).toBe('/login');
    expect(to.searchParams.get('next')).toBe('/dashboard/payments?status=failed');
  });

  it('lets a visitor with a session cookie through', () => {
    const res = proxy(request('/dashboard', SESSION_COOKIE));
    expect(getRedirectUrl(res)).toBeNull();
  });
});
