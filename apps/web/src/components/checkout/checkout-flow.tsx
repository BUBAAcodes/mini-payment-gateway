'use client';

import { useEffect, useRef, useState } from 'react';
import { screenFor, type CheckoutPayment, type Screen } from '@/lib/checkout';
import { OrderSummary } from './order-summary';
import { OtpScreen } from './otp-screen';
import { PayForm } from './pay-form';
import { ProgressLine } from './progress-line';
import { ProcessingScreen } from './processing-screen';
import { ResultScreen } from './result-screen';
import { SCREEN_HEADING_ID } from './ui';

/** What the screens need to know about the order. Strings only: formatting happened on the server. */
export interface CheckoutOrderView {
  id: string;
  /** The order's client secret from the URL. Every call to the API needs it. */
  cs: string;
  merchantName: string;
  amountLabel: string;
}

interface CheckoutFlowProps {
  order: CheckoutOrderView;
  /** The newest attempt, if the page was refreshed partway through. */
  initialPayment: CheckoutPayment | null;
}

interface State {
  screen: Screen;
  payment: CheckoutPayment | null;
}

/**
 * The checkout's screens (section 13): pay form → OTP (cards) → processing → success or failure.
 * Every answer from the API comes back as a payment, and screenFor() picks the screen for it.
 */
export function CheckoutFlow({ order, initialPayment }: CheckoutFlowProps) {
  const [state, setState] = useState<State>(() => ({
    screen: screenFor(initialPayment),
    payment: initialPayment,
  }));
  const isFirstScreen = useRef(true);

  // Move focus into each new screen so screen readers announce it. An OTP field asks for focus
  // itself (data-autofocus), so the customer can type the code straight away.
  useEffect(() => {
    const wanted = document.querySelector<HTMLElement>('[data-autofocus]');
    if (wanted) wanted.focus();
    else if (!isFirstScreen.current) document.getElementById(SCREEN_HEADING_ID)?.focus();
    isFirstScreen.current = false;
  }, [state.screen]);

  const show = (payment: CheckoutPayment) => setState({ screen: screenFor(payment), payment });
  const tryAgain = () => setState((s) => ({ screen: 'form', payment: s.payment }));
  // The order moved on elsewhere (another tab, a double click): let the server pick the screen.
  const reload = () => window.location.reload();

  const { screen, payment } = state;

  if (screen === 'otp' && payment) {
    return <OtpScreen order={order} payment={payment} onResult={show} onStale={reload} />;
  }

  return (
    <div className="grid gap-12 md:grid-cols-[1fr_minmax(0,440px)] md:gap-16">
      <OrderSummary
        merchantName={order.merchantName}
        amountLabel={order.amountLabel}
        orderId={order.id}
      />
      <div>
        <ProgressLine screen={screen} />
        {screen === 'form' || !payment ? (
          <PayForm order={order} defaultMethod={payment?.method} onResult={show} onStale={reload} />
        ) : screen === 'processing' ? (
          <ProcessingScreen order={order} payment={payment} onResult={show} />
        ) : (
          <ResultScreen order={order} payment={payment} onTryAgain={tryAgain} />
        )}
      </div>
    </div>
  );
}
