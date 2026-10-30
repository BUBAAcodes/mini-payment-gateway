'use client';

import { useEffect, useState } from 'react';
import {
  failureMessage,
  paymentMethodLabel,
  screenFor,
  type CheckoutPayment,
} from '@/lib/checkout';
import type { CheckoutOrderView } from './checkout-flow';
import { Eyebrow, SCREEN_HEADING_ID, buttonStyles, cx } from './ui';

const REDIRECT_DELAY_S = 3;

interface ResultScreenProps {
  order: CheckoutOrderView;
  payment: CheckoutPayment;
  onTryAgain: () => void;
}

/**
 * Success or failure. redirect_url is the merchant's callback_url with order_id, payment_id,
 * status and the signature, built by the API (section 9.1, step 9). It is null if the merchant
 * gave no callback_url.
 */
export function ResultScreen({ order, payment, onTryAgain }: ResultScreenProps) {
  return screenFor(payment) === 'success' ? (
    <SuccessPanel order={order} payment={payment} />
  ) : (
    <FailurePanel order={order} payment={payment} onTryAgain={onTryAgain} />
  );
}

function SuccessPanel({ order, payment }: Omit<ResultScreenProps, 'onTryAgain'>) {
  const redirectUrl = payment.redirect_url;
  const [secondsLeft, setSecondsLeft] = useState(REDIRECT_DELAY_S);

  // Send the customer back to the merchant after a short pause, so they see the result.
  useEffect(() => {
    if (!redirectUrl) return;
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const left = REDIRECT_DELAY_S - Math.floor((Date.now() - startedAt) / 1000);
      if (left > 0) return setSecondsLeft(left);
      clearInterval(tick);
      window.location.assign(redirectUrl);
    }, 250);
    return () => clearInterval(tick);
  }, [redirectUrl]);

  return (
    <section aria-labelledby={SCREEN_HEADING_ID} className="rounded-card bg-card p-6 md:p-8">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <CheckIcon />
      </span>
      <Eyebrow className="mt-6">Payment successful</Eyebrow>
      <h2
        id={SCREEN_HEADING_ID}
        tabIndex={-1}
        className="font-display mt-2 text-3xl uppercase outline-none md:text-4xl"
      >
        {order.amountLabel} paid
      </h2>
      <PaymentDetails order={order} payment={payment} />
      {redirectUrl ? (
        <>
          <p role="status" className="mt-6 text-sm text-muted-foreground">
            Taking you back to {order.merchantName} in {secondsLeft}…
          </p>
          <a href={redirectUrl} className={cx(buttonStyles.primary, 'mt-4 w-full')}>
            Continue to {order.merchantName}
          </a>
        </>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">You can close this window.</p>
      )}
    </section>
  );
}

function FailurePanel({ order, payment, onTryAgain }: ResultScreenProps) {
  return (
    <section aria-labelledby={SCREEN_HEADING_ID} className="rounded-card bg-card p-6 md:p-8">
      <span className="flex size-12 items-center justify-center rounded-full border-2 border-destructive text-destructive">
        <CrossIcon />
      </span>
      <Eyebrow className="mt-6">Payment failed</Eyebrow>
      <h2
        id={SCREEN_HEADING_ID}
        tabIndex={-1}
        className="font-display mt-2 text-3xl uppercase outline-none md:text-4xl"
      >
        Not completed
      </h2>
      <p role="alert" className="mt-4 text-base">
        {failureMessage(payment.failure_reason)}
      </p>
      <PaymentDetails order={order} payment={payment} />
      <div className="mt-8 flex flex-col gap-3">
        <button type="button" onClick={onTryAgain} className={cx(buttonStyles.primary, 'w-full')}>
          Try again
        </button>
        {payment.redirect_url && (
          <a href={payment.redirect_url} className={cx(buttonStyles.secondary, 'w-full')}>
            Return to {order.merchantName}
          </a>
        )}
      </div>
    </section>
  );
}

function PaymentDetails({ order, payment }: Omit<ResultScreenProps, 'onTryAgain'>) {
  return (
    <dl className="mt-6 space-y-3 border-t border-border pt-5 text-sm">
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">To</dt>
        <dd className="font-medium">{order.merchantName}</dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Method</dt>
        <dd className="font-medium">{paymentMethodLabel(payment)}</dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Payment</dt>
        <dd className="font-medium break-all tabular-nums">{payment.id}</dd>
      </div>
    </dl>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.5 10 17.5 19 7" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
