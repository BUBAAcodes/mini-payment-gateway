import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Sends logged-out visitors from the dashboard to /login, remembering where they were going.
 * It only checks that a session cookie exists, which is quick and needs no database. Whether the
 * session is real is checked by requireMerchant() on every page; a stale cookie ends up at /login
 * from there.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  const login = new URL('/login', request.url);
  login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
