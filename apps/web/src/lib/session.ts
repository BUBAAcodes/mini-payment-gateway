import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from './auth';

export interface DashboardUser {
  /** The only merchant ID dashboard code may pass to the dashboard API. */
  merchantId: string;
  name: string;
  email: string;
}

/**
 * The logged-in user and their merchant, or a redirect to /login. Every dashboard page and action
 * goes through here: proxy.ts only checks that a cookie exists, this checks the session is real.
 * Cached per request, so a page and its components share one lookup.
 */
export const requireMerchant = cache(async (): Promise<DashboardUser> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const { merchantId, name, email } = session.user;
  // Every login is created with a merchant; one without is a data problem, not a user mistake.
  if (!merchantId) throw new Error(`User ${session.user.id} is not linked to a merchant`);
  return { merchantId, name, email };
});
