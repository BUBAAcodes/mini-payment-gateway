/** Shown while the order loads. Same grid as the checkout, so nothing jumps when it arrives. */
export function CheckoutSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading payment"
      className="grid gap-10 md:grid-cols-[1fr_minmax(0,440px)]"
    >
      <div className="space-y-5">
        <div className="h-4 w-40 animate-pulse rounded-control bg-muted" />
        <div className="h-16 w-64 animate-pulse rounded-control bg-muted" />
        <div className="h-4 w-52 animate-pulse rounded-control bg-muted" />
      </div>
      <div className="h-96 animate-pulse rounded-card bg-card" />
    </div>
  );
}
