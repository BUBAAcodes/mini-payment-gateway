'use client';

import { useRef, useState, useTransition, type FormEvent } from 'react';
import { submitOtpCode } from '@/app/pay/[orderId]/actions';
import { OTP_LENGTH, paymentMethodLabel, type CheckoutPayment } from '@/lib/checkout';
import type { CheckoutOrderView } from './checkout-flow';
import { LiquidBackground } from './liquid-background';
import { OtpBoxes } from './otp-boxes';
import { SCREEN_HEADING_ID, Spinner, cx } from './ui';

interface OtpScreenProps {
  order: CheckoutOrderView;
  payment: CheckoutPayment;
  onResult: (payment: CheckoutPayment) => void;
  onStale: () => void;
}

/**
 * The card OTP step. In real life this page belongs to the customer's bank, so it takes over the
 * screen in the bank's own (dark) look, after the access-code reference. The test-mode banner
 * stays on top (rule 13). A wrong OTP fails the payment; "Try again" starts a new attempt.
 */
export function OtpScreen({ order, payment, onResult, onStale }: OtpScreenProps) {
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Typing the sixth digit and pressing Enter can both submit; send the code only once.
  const sent = useRef(false);

  function submit(code: string) {
    if (code.length !== OTP_LENGTH || sent.current) return;
    sent.current = true;
    setError(null);
    startTransition(async () => {
      const result = await submitOtpCode(payment.id, order.cs, code);
      if (result.ok) return onResult(result.data);
      // 409 or 422: the payment moved on elsewhere. Let the server pick the screen.
      if (result.error.code === 'conflict' || result.error.code === 'invalid_state') {
        return onStale();
      }
      sent.current = false;
      setError(result.error.message);
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submit(otp);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center overflow-hidden bg-bank-background text-bank-foreground">
      {/* Layers from the reference: liquid, veil, two blooms, vignette. */}
      <LiquidBackground />
      <div aria-hidden="true" className="absolute inset-0 bg-[#0606068c]" />
      <div
        aria-hidden="true"
        className="absolute -top-[140px] -right-[70px] size-[700px] rounded-full bg-[radial-gradient(50%_50%_at_50%_50%,#9b8cff47_0%,#9b8cff00_68%)]"
      />
      <div
        aria-hidden="true"
        className="absolute -bottom-[180px] -left-[100px] h-[600px] w-[820px] rounded-full bg-[radial-gradient(50%_50%_at_50%_50%,#9b8cff29_0%,#9b8cff00_70%)]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(50%_50%_at_50%_50%,#06060600_38%,#060606c2_100%)]"
      />

      <form
        onSubmit={onSubmit}
        className="relative z-10 flex w-full max-w-[640px] flex-col items-center gap-[18px] px-6 py-14 text-center sm:px-10"
      >
        <h1
          id={SCREEN_HEADING_ID}
          tabIndex={-1}
          className="text-xs font-semibold tracking-[0.22em] text-bank-accent uppercase outline-none"
        >
          Test Bank · OTP
        </h1>
        <div>
          <p className="text-lg font-medium">
            {order.amountLabel} to {order.merchantName}
          </p>
          <p className="mt-1 text-sm text-bank-foreground/60">{paymentMethodLabel(payment)}</p>
        </div>

        <OtpBoxes
          value={otp}
          onChange={setOtp}
          onComplete={submit}
          disabled={isPending}
          describedBy="otp-helper"
        />

        <p
          id="otp-helper"
          className={cx(
            'min-h-[1.35em] max-w-xs text-[13px] leading-[1.35] font-medium tracking-[0.01em]',
            error ? 'text-[#ff9b9b]' : 'text-bank-foreground/42',
          )}
        >
          {error ?? 'Test OTP 123456 · paste works'}
        </p>

        <button
          type="submit"
          disabled={isPending || otp.length !== OTP_LENGTH}
          className="inline-flex items-center gap-2 rounded-otp bg-bank-foreground px-6 py-3 text-sm font-semibold text-bank-background transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bank-accent disabled:opacity-40"
        >
          {isPending && <Spinner />}
          {isPending ? 'Verifying…' : 'Verify'}
        </button>
        <p role="status" className="sr-only">
          {isPending ? 'Verifying the code with Test Bank' : ''}
        </p>
      </form>
    </div>
  );
}
