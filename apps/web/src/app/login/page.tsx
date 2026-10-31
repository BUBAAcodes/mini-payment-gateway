import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { Eyebrow } from '@/components/checkout/ui';
import { LoginForm } from '@/components/dashboard/login-form';
import { Skeleton } from '@/components/ui/skeleton';
import { auth } from '@/lib/auth';
import { BRAND_NAME } from '@/lib/checkout';
import { safeNextPath } from '@/lib/redirects';

export const metadata: Metadata = { title: `Log in · ${BRAND_NAME}` };

/** The public demo login the seed creates (DEMO_LOGIN in packages/db/src/seed.ts). */
const DEMO = { email: 'demo@gateway.test', password: 'demo-password' };

const POINTS = [
  'Orders, UPI and card payments with OTP, against a pretend bank',
  'A double-entry ledger, refunds and daily settlements',
  'Signed webhooks with retries, and reconciliation against the bank file',
];

export default function LoginPage({ searchParams }: PageProps<'/login'>) {
  return (
    <main className="grid min-h-screen flex-1 md:grid-cols-[1.1fr_1fr]">
      <section className="flex flex-col justify-between gap-10 bg-foreground p-8 text-background md:p-12">
        <div className="flex items-center justify-between gap-4">
          <span className="font-display text-lg uppercase">{BRAND_NAME}</span>
          <span className="rounded-full bg-background/15 px-2.5 py-0.5 font-pill text-xs font-medium">
            Test mode
          </span>
        </div>
        <div>
          <h1 className="font-display text-5xl leading-[1.05] uppercase md:text-7xl">
            Payments, minus the real money
          </h1>
          <ul className="mt-8 hidden max-w-md space-y-3 text-background/70 md:block">
            {POINTS.map((point) => (
              <li key={point} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="mt-2.5 size-1.5 shrink-0 rounded-full bg-background/70"
                />
                {point}
              </li>
            ))}
          </ul>
        </div>
        <p className="hidden text-sm text-background/50 md:block">
          A learning project. No real banks, cards or money are involved.
        </p>
      </section>

      <section className="flex flex-col justify-center px-6 py-12 md:px-16">
        <div className="mx-auto w-full max-w-sm">
          <Eyebrow>Merchant dashboard</Eyebrow>
          <h2 className="font-display mt-2 mb-8 text-4xl uppercase">Log in</h2>
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <LoginGate searchParams={searchParams} />
          </Suspense>
          <div className="mt-8 rounded-card bg-card p-4 text-sm">
            <p className="font-medium">Just looking around?</p>
            <p className="mt-1 text-muted-foreground">
              Use the demo login: <code className="font-mono text-foreground">{DEMO.email}</code>{' '}
              with password <code className="font-mono text-foreground">{DEMO.password}</code>.
            </p>
          </div>
        </div>
      </section>
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
