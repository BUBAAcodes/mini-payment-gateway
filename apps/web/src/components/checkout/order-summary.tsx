import { Eyebrow } from './ui';

interface OrderSummaryProps {
  merchantName: string;
  amountLabel: string;
  orderId: string;
}

/** The left column: who is being paid and how much, in the reference's big display type. */
export function OrderSummary({ merchantName, amountLabel, orderId }: OrderSummaryProps) {
  return (
    <section aria-label="Order summary" className="md:pt-2">
      <Eyebrow>Paying {merchantName}</Eyebrow>
      <h1 className="font-display mt-4 animate-blur-in text-6xl tabular-nums md:text-7xl">
        <span className="sr-only">Pay </span>
        {amountLabel}
      </h1>
      <dl className="mt-10 space-y-3 border-t border-border pt-6 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Merchant</dt>
          <dd className="font-medium">{merchantName}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Order</dt>
          <dd className="font-medium break-all tabular-nums">{orderId}</dd>
        </div>
      </dl>
      <p className="mt-6 max-w-sm text-sm text-muted-foreground">
        This is a test payment. Use the test details listed with each method; nothing is charged.
      </p>
    </section>
  );
}
