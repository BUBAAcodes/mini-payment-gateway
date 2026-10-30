'use client';

import { useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from 'react';
import { payWithCard, payWithUpi } from '@/app/pay/[orderId]/actions';
import {
  formatCardNumber,
  formatExpiryInput,
  type ApiError,
  type CheckoutPayment,
} from '@/lib/checkout';
import type { CheckoutOrderView } from './checkout-flow';
import { Field, SCREEN_HEADING_ID, Spinner, buttonStyles, cx, errorId, inputStyles } from './ui';

type Method = 'upi' | 'card';

const METHODS: { value: Method; label: string }[] = [
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
];

// The fake bank's test inputs (section 10), listed under each form.
const TEST_UPI_IDS = [
  { vpa: 'success@test', note: 'Approves' },
  { vpa: 'fail@test', note: 'Declines' },
  { vpa: 'slow@test', note: 'Slow bank' },
  { vpa: 'lost@test', note: 'Bank never answers' },
];

const TEST_CARDS = [
  { number: '4111 1111 1111 1111', note: 'Approves after the OTP' },
  { number: '4000 0000 0000 0002', note: 'Declined' },
];

/** The API names expiry_month or expiry_year; the form has one expiry field. */
function formField(apiField: string | undefined): string | undefined {
  return apiField?.startsWith('card.expiry') ? 'card.expiry' : apiField;
}

const KNOWN_FIELDS = new Set(['vpa', 'card.number', 'card.expiry', 'card.name']);

interface PayFormProps {
  order: CheckoutOrderView;
  /** After a failed attempt, start on the method the customer used. */
  defaultMethod?: Method;
  onResult: (payment: CheckoutPayment) => void;
  onStale: () => void;
}

export function PayForm({ order, defaultMethod = 'upi', onResult, onStale }: PayFormProps) {
  const [method, setMethod] = useState<Method>(defaultMethod);
  const [vpa, setVpa] = useState('');
  const [card, setCard] = useState({ number: '', expiry: '', name: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [isPending, startTransition] = useTransition();
  const tabs = useRef<Record<Method, HTMLButtonElement | null>>({ upi: null, card: null });

  const field = formField(error?.field);
  const fieldError = (name: string) => (field === name ? error?.message : undefined);
  const generalError = error && !KNOWN_FIELDS.has(field ?? '') ? error.message : undefined;

  function chooseMethod(next: Method) {
    setMethod(next);
    setError(null);
  }

  // Left and right arrows move between the tabs, as the ARIA tabs pattern expects.
  function onTabKeyDown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const next = method === 'upi' ? 'card' : 'upi';
    chooseMethod(next);
    tabs.current[next]?.focus();
  }

  function fillTestCard(number: string) {
    const nextYear = String((new Date().getFullYear() + 1) % 100).padStart(2, '0');
    setCard((c) => ({
      number,
      expiry: c.expiry || `12/${nextYear}`,
      name: c.name || 'Test Customer',
    }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result =
        method === 'upi'
          ? await payWithUpi(order.id, order.cs, vpa)
          : await payWithCard(order.id, order.cs, card);
      if (result.ok) return onResult(result.data);
      // 409: another attempt is in progress. 422: the order is already paid.
      if (result.error.code === 'conflict' || result.error.code === 'invalid_state') {
        return onStale();
      }
      setError(result.error);
    });
  }

  return (
    <section aria-labelledby={SCREEN_HEADING_ID} className="rounded-card bg-card p-6 md:p-8">
      <h2
        id={SCREEN_HEADING_ID}
        tabIndex={-1}
        className="font-display text-2xl uppercase outline-none md:text-3xl"
      >
        Choose how to pay
      </h2>

      <div
        role="tablist"
        aria-label="Payment method"
        className="mt-6 grid grid-cols-2 gap-1 rounded-control bg-muted p-1"
      >
        {METHODS.map(({ value, label }) => (
          <button
            key={value}
            ref={(el) => {
              tabs.current[value] = el;
            }}
            type="button"
            role="tab"
            id={`method-tab-${value}`}
            aria-selected={method === value}
            aria-controls="method-panel"
            tabIndex={method === value ? 0 : -1}
            onClick={() => chooseMethod(value)}
            onKeyDown={onTabKeyDown}
            className={cx(
              'rounded-[4px] px-4 py-2.5 text-sm font-medium tracking-[-0.01em] uppercase transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              method === value
                ? 'bg-primary text-primary-foreground'
                : 'text-foreground hover:bg-background/70',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <form
        id="method-panel"
        role="tabpanel"
        aria-labelledby={`method-tab-${method}`}
        onSubmit={submit}
        noValidate
        className="mt-6 space-y-5"
      >
        <fieldset disabled={isPending} className="space-y-5">
          {method === 'upi' ? (
            <>
              <Field id="vpa" label="UPI ID" error={fieldError('vpa')}>
                <input
                  id="vpa"
                  value={vpa}
                  onChange={(e) => setVpa(e.target.value)}
                  placeholder="name@bank"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={fieldError('vpa') ? true : undefined}
                  aria-describedby={fieldError('vpa') ? errorId('vpa') : undefined}
                  className={inputStyles}
                />
              </Field>
              <TestInputs
                title="Test UPI IDs"
                items={TEST_UPI_IDS.map(({ vpa: id, note }) => ({ value: id, note }))}
                onPick={setVpa}
              />
            </>
          ) : (
            <>
              {/* autoComplete off: this is test mode, so browsers shouldn't offer saved real cards. */}
              <Field id="card-number" label="Card number" error={fieldError('card.number')}>
                <input
                  id="card-number"
                  value={card.number}
                  onChange={(e) => setCard({ ...card, number: formatCardNumber(e.target.value) })}
                  inputMode="numeric"
                  placeholder="4111 1111 1111 1111"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={fieldError('card.number') ? true : undefined}
                  aria-describedby={fieldError('card.number') ? errorId('card-number') : undefined}
                  className={cx(inputStyles, 'tabular-nums')}
                />
              </Field>
              <div className="grid grid-cols-[minmax(0,7rem)_1fr] gap-4">
                <Field id="card-expiry" label="Expiry" error={fieldError('card.expiry')}>
                  <input
                    id="card-expiry"
                    value={card.expiry}
                    onChange={(e) =>
                      setCard({ ...card, expiry: formatExpiryInput(e.target.value) })
                    }
                    inputMode="numeric"
                    placeholder="MM/YY"
                    autoComplete="off"
                    aria-invalid={fieldError('card.expiry') ? true : undefined}
                    aria-describedby={
                      fieldError('card.expiry') ? errorId('card-expiry') : undefined
                    }
                    className={cx(inputStyles, 'tabular-nums')}
                  />
                </Field>
                <Field id="card-name" label="Name on card" error={fieldError('card.name')}>
                  <input
                    id="card-name"
                    value={card.name}
                    onChange={(e) => setCard({ ...card, name: e.target.value })}
                    placeholder="Test Customer"
                    autoComplete="off"
                    aria-invalid={fieldError('card.name') ? true : undefined}
                    aria-describedby={fieldError('card.name') ? errorId('card-name') : undefined}
                    className={inputStyles}
                  />
                </Field>
              </div>
              <TestInputs
                title="Test cards · any future expiry · OTP 123456"
                items={TEST_CARDS.map(({ number, note }) => ({ value: number, note }))}
                onPick={fillTestCard}
              />
            </>
          )}
        </fieldset>

        {generalError && (
          <p
            role="alert"
            className="rounded-control border border-destructive px-4 py-3 text-sm text-destructive"
          >
            {generalError}
          </p>
        )}

        <button type="submit" disabled={isPending} className={cx(buttonStyles.primary, 'w-full')}>
          {isPending && <Spinner />}
          {isPending
            ? method === 'upi'
              ? 'Waiting for your bank…'
              : 'Starting payment…'
            : `Pay ${order.amountLabel}`}
        </button>
        <p role="status" className="sr-only">
          {isPending ? 'Processing your payment' : ''}
        </p>
      </form>
    </section>
  );
}

interface TestInputsProps {
  title: string;
  items: { value: string; note: string }[];
  onPick: (value: string) => void;
}

/** The reference's white pills, here as one-click test inputs. */
function TestInputs({ title, items, onPick }: TestInputsProps) {
  return (
    <div>
      <p className="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        {title}
      </p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {items.map(({ value, note }) => (
          <li key={value}>
            <button
              type="button"
              onClick={() => onPick(value)}
              className="rounded-full bg-background px-3 py-1.5 font-pill text-sm font-medium tracking-[-0.01em] transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="tabular-nums">{value}</span>
              <span className="text-muted-foreground"> · {note}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
