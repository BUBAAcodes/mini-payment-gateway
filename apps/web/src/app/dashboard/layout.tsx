import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DashboardNav, NavLinks } from '@/components/dashboard/nav';
import { Button } from '@/components/ui/button';
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
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 pt-5 pb-2">
          <span className="font-display text-lg uppercase">{BRAND_NAME}</span>
          <Suspense fallback={null}>
            <Account />
          </Suspense>
        </div>
        <div className="mx-auto max-w-6xl px-6">
          <Suspense fallback={<NavLinks pathname={null} />}>
            <DashboardNav />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">{children}</main>
    </div>
  );
}

async function Account() {
  const user = await requireMerchant();
  return (
    <div className="flex items-center gap-4">
      <span className="hidden text-sm text-muted-foreground sm:inline">{user.email}</span>
      <span className="rounded-full bg-muted px-2.5 py-0.5 font-pill text-xs font-medium">
        Test mode
      </span>
      <form action={logOut}>
        <Button type="submit" variant="outline" size="sm">
          Log out
        </Button>
      </form>
    </div>
  );
}
