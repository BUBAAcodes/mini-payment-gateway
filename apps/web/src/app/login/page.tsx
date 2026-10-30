import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { Eyebrow } from '@/components/checkout/ui';
import { LoginForm } from '@/components/dashboard/login-form';
import { auth } from '@/lib/auth';
import { BRAND_NAME } from '@/lib/checkout';
import { safeNextPath } from '@/lib/redirects';

export const metadata: Metadata = { title: `Log in · ${BRAND_NAME}` };

export default function LoginPage({ searchParams }: PageProps<'/login'>) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16">
      <Eyebrow>{BRAND_NAME} · Test mode</Eyebrow>
      <h1 className="mt-2 mb-8 text-3xl font-semibold tracking-tight">Log in to your dashboard</h1>
      <Suspense fallback={<div className="h-64" />}>
        <LoginGate searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

/** Already logged in with a real session: skip the form. A stale cookie gets the form. */
async function LoginGate({ searchParams }: Pick<PageProps<'/login'>, 'searchParams'>) {
  const next = safeNextPath((await searchParams).next);
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect(next);
  return <LoginForm next={next} />;
}
