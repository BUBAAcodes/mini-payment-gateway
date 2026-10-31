'use client';

import { Landmark } from 'lucide-react';
import { useEffect, useEffectEvent, useState } from 'react';
import { refreshPayment } from '@/app/pay/[orderId]/actions';
import { paymentMethodLabel, screenFor, type CheckoutPayment } from '@/lib/checkout';
import type { CheckoutOrderView } from './checkout-flow';
import { SCREEN_HEADING_ID } from './ui';

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
      <div className="relative flex size-14 items-center justify-center">
        {/* Two rings ripple out while we wait; the global reduced-motion rule stills them. */}
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-ping rounded-full bg-foreground/10 [animation-duration:2s]"
        />
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-ping rounded-full bg-foreground/10 [animation-delay:1s] [animation-duration:2s]"
        />
        <span className="relative flex size-14 items-center justify-center rounded-full bg-foreground text-background">
          <Landmark aria-hidden="true" className="size-6" />
        </span>
      </div>
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
      <div className="mt-6 flex items-center justify-between gap-4 text-sm">
        <p className="font-medium">{paymentMethodLabel(payment)}</p>
        <Elapsed />
      </div>
    </section>
  );
}

/** Seconds since this screen opened, so a slow bank doesn't look like a frozen page. */
function Elapsed() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const tick = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(tick);
  }, []);
  return (
    <p className="text-muted-foreground tabular-nums" aria-live="off">
      Waiting {seconds}s
    </p>
  );
}
