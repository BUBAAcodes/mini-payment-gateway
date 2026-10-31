import { Skeleton } from '@/components/ui/skeleton';

// Page-shaped placeholders while data streams in, so the layout doesn't jump when it arrives.
// Screen readers get one "Loading" instead of a pile of empty blocks.

function Loading({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" aria-label="Loading">
      {children}
    </div>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Loading>
      <Skeleton className="mb-3 h-9 w-full" />
      <div className="space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    </Loading>
  );
}

export function CardsSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <Loading>
      <div className="space-y-4">
        {Array.from({ length: cards }, (_, i) => (
          <Skeleton key={i} className="h-36 w-full rounded-card" />
        ))}
      </div>
    </Loading>
  );
}

export function OverviewSkeleton() {
  return (
    <Loading>
      <Skeleton className="mb-3 h-4 w-24" />
      <Skeleton className="mb-8 h-9 w-64" />
      <div className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-44 rounded-card" />
        ))}
      </div>
      <Skeleton className="mt-4 h-64 rounded-card" />
      <Skeleton className="mt-12 mb-4 h-7 w-48" />
      <TableSkeleton rows={5} />
    </Loading>
  );
}

export function DetailSkeleton() {
  return (
    <Loading>
      <Skeleton className="mt-4 mb-3 h-4 w-20" />
      <Skeleton className="mb-8 h-10 w-48" />
      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <Skeleton className="h-72 rounded-card" />
        <Skeleton className="h-72 rounded-card" />
      </div>
    </Loading>
  );
}
