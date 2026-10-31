'use client';

import { useActionState } from 'react';
import { Spinner } from '@/components/checkout/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { KeyedState } from '@/lib/action-state';
import { FormMessage } from './form-message';

interface RefundFormProps {
  action: (state: KeyedState, formData: FormData) => Promise<KeyedState>;
  /** Made by the page; the action hands back the next one after each answer. */
  idempotencyKey: string;
  /** What is left to refund, already formatted, e.g. "₹300.00". */
  remaining: string;
}

export function RefundForm({ action, idempotencyKey, remaining }: RefundFormProps) {
  const [state, run, pending] = useActionState(action, { status: 'idle', idempotencyKey });
  const amountError = state.status === 'error' && state.field === 'amount';

  return (
    <form action={run} className="space-y-4">
      <input type="hidden" name="idempotency_key" value={state.idempotencyKey} />
      <div className="space-y-2">
        <Label htmlFor="refund-amount">Amount in ₹</Label>
        <Input
          id="refund-amount"
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder={`Leave empty to refund ${remaining}`}
          aria-invalid={amountError}
          aria-describedby="refund-message"
          className="max-w-xs"
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending && <Spinner />}
        {pending ? 'Refunding…' : 'Refund'}
      </Button>
      <FormMessage state={state} className="mt-1" />
      <span id="refund-message" className="sr-only">
        {state.status === 'error' ? state.message : ''}
      </span>
    </form>
  );
}
