'use server';

import { isAPIError } from 'better-auth/api';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { safeNextPath } from '@/lib/redirects';

export interface LoginState {
  error: string | null;
  email: string;
}

const WRONG_LOGIN = 'Wrong email or password.';

/** Logs in and goes to `next`. A Server Action is a public endpoint: every field is untrusted. */
export async function logIn(_previous: LoginState, form: FormData): Promise<LoginState> {
  const email = form.get('email');
  const password = form.get('password');
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return {
      error: 'Enter your email and password.',
      email: typeof email === 'string' ? email : '',
    };
  }

  try {
    // The nextCookies() plugin sets the session cookie on this action's response.
    await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
  } catch (err) {
    // The same message whether the email or the password was wrong.
    if (isAPIError(err)) return { error: WRONG_LOGIN, email };
    throw err;
  }
  // Outside the try: redirect() works by throwing.
  redirect(safeNextPath(form.get('next')));
}
