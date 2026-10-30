'use client';

import { useActionState } from 'react';
import { logIn, type LoginState } from '@/app/login/actions';
import { Field, Spinner, buttonStyles, cx, errorId, inputStyles } from '@/components/checkout/ui';

const INITIAL: LoginState = { error: null, email: '' };

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(logIn, INITIAL);
  const describedBy = state.error ? errorId('password') : undefined;

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="next" value={next} />
      <Field id="email" label="Email">
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          defaultValue={state.email}
          aria-invalid={Boolean(state.error)}
          aria-describedby={describedBy}
          className={inputStyles}
        />
      </Field>
      <Field id="password" label="Password" error={state.error ?? undefined}>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={Boolean(state.error)}
          aria-describedby={describedBy}
          className={inputStyles}
        />
      </Field>
      <button type="submit" disabled={pending} className={cx(buttonStyles.primary, 'w-full')}>
        {pending && <Spinner />}
        Log in
      </button>
    </form>
  );
}
