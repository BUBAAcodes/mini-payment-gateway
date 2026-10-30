import type { Metadata } from 'next';
import { TestModeBanner } from '@/components/checkout/test-mode-banner';
import { BRAND_NAME } from '@/lib/checkout';

export const metadata: Metadata = {
  title: `Checkout · ${BRAND_NAME}`,
  // Payment links carry a client secret; keep them out of search engines.
  robots: { index: false, follow: false },
};

/** The checkout frame. A layout, so the invalid-link page gets the same banner and header. */
export default function PayLayout({ children }: LayoutProps<'/pay'>) {
  return (
    <div className="flex min-h-screen flex-1 flex-col bg-background">
      <TestModeBanner />
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <span className="font-display text-lg uppercase">{BRAND_NAME}</span>
          <span className="text-sm font-medium tracking-[-0.01em] text-muted-foreground uppercase">
            Secure checkout
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12 md:py-20">{children}</main>
      <footer className="border-t border-border">
        <p className="mx-auto max-w-5xl px-6 py-6 text-sm text-muted-foreground">
          {BRAND_NAME} runs in test mode only. No real money moves.
        </p>
      </footer>
    </div>
  );
}
