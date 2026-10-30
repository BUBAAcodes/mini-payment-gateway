'use client';

import { useEffect, useEffectEvent } from 'react';
import { refreshPayment } from '@/app/pay/[orderId]/actions';
import { paymentMethodLabel, screenFor, type CheckoutPayment } from '@/lib/checkout';
import type { CheckoutOrderView } from './checkout-flow';
import { SCREEN_HEADING_ID, Spinner } from './ui';

const POLL_INTERVAL_MS = 2_000;

interface ProcessingScreenProps {
  order: CheckoutOrderView;
  payment: CheckoutPayment;
  onResult: (payment: CheckoutPayment) => void;
}

/**
 * The bank hasn't answered yet. A timeout means "unknown", never "failed" (rule 10), so we keep
 * asking until the status-check job settles it: slow@test in about 30 s, lost@test after 15 min.
 */
export function ProcessingScreen({ order, payment, onResult }: ProcessingScreenProps) {
  const onSettled = useEffectEvent(onResult);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    // One request at a time: the next poll starts only after this one answers.
    async function poll() {
      const result = await refreshPayment(payment.id, order.cs);
      if (stopped) return;
      if (result.ok && screenFor(result.data) !== 'processing') return onSettled(result.data);
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    }
    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [payment.id, order.cs]);

  return (
    <section aria-labelledby={SCREEN_HEADING_ID} className="rounded-card bg-card p-6 md:p-8">
      <Spinner className="size-8" />
      <h2
        id={SCREEN_HEADING_ID}
        tabIndex={-1}
        className="font-display mt-6 text-2xl uppercase outline-none md:text-3xl"
      >
        Confirming with your bank
      </h2>
      <p className="mt-3 text-muted-foreground">
        Some banks take a while to answer. Keep this page open; it updates as soon as yours does.
      </p>
      <p role="status" className="mt-6 text-sm font-medium">
        {paymentMethodLabel(payment)}
      </p>
    </section>
  );
}
