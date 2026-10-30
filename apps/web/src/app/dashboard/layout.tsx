import type { Metadata } from 'next';
import { Suspense } from 'react';
import { buttonStyles } from '@/components/checkout/ui';
import { BRAND_NAME } from '@/lib/checkout';
import { requireMerchant } from '@/lib/session';
import { logOut } from './actions';

export const metadata: Metadata = {
  title: `Dashboard · ${BRAND_NAME}`,
  robots: { index: false, follow: false },
};

/** The dashboard frame. The session is read inside Suspense, so the frame streams at once. */
export default function DashboardLayout({ children }: LayoutProps<'/dashboard'>) {
  return (
    <div className="flex min-h-screen flex-1 flex-col bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-5">
          <span className="font-display text-lg uppercase">{BRAND_NAME}</span>
          <Suspense fallback={null}>
            <Account />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">{children}</main>
    </div>
  );
}

async function Account() {
  const user = await requireMerchant();
  return (
    <div className="flex items-center gap-4">
      <span className="text-sm text-muted-foreground">{user.email}</span>
      <form action={logOut}>
        <button type="submit" className={buttonStyles.secondary}>
          Log out
        </button>
      </form>
    </div>
  );
}
