import type { ReactNode } from 'react';
import { Eyebrow } from '@/components/checkout/ui';

export function PageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  /** A sentence on what the page is for. */
  children?: ReactNode;
}) {
  return (
    <header className="mb-8 space-y-2">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className="font-display text-3xl uppercase">{title}</h1>
      {children && <p className="max-w-2xl text-muted-foreground">{children}</p>}
    </header>
  );
}

/** An error from the API, in place of the content it stopped. */
export function LoadError({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-card bg-card p-6 text-destructive">
      {message}
    </p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-card bg-card p-6 text-muted-foreground">{children}</p>;
}
