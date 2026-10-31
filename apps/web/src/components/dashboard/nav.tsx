'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/payments', label: 'Payments' },
  { href: '/dashboard/api-keys', label: 'API keys' },
  { href: '/dashboard/webhooks', label: 'Webhooks' },
  { href: '/dashboard/events', label: 'Events' },
  { href: '/dashboard/settlements', label: 'Settlements' },
  { href: '/dashboard/reconciliation', label: 'Reconciliation' },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === '/dashboard' ? pathname === href : pathname.startsWith(href);
}

/** The dashboard's sections, with the current one underlined. */
export function DashboardNav() {
  return <NavLinks pathname={usePathname()} />;
}

/**
 * The links themselves. The layout renders this with no pathname as DashboardNav's Suspense
 * fallback: the path is only known per request, so prerendering can't include it.
 */
export function NavLinks({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Dashboard" className="-mb-px flex gap-6 overflow-x-auto">
      {LINKS.map(({ href, label }) => {
        const active = pathname !== null && isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'shrink-0 border-b-2 py-3 text-sm font-medium tracking-[-0.01em] uppercase transition-colors',
              active
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
