'use client';

import { useActionState } from 'react';
import { Spinner } from '@/components/checkout/ui';
import { Button } from '@/components/ui/button';
import type { SecretState } from '@/lib/action-state';
import { FormMessage } from './form-message';
import { SecretOnce } from './secret-once';

export function CreateKeyForm({
  action,
}: {
  action: (state: SecretState, formData: FormData) => Promise<SecretState>;
}) {
  const [state, run, pending] = useActionState(action, { status: 'idle' });

  return (
    <div className="space-y-4">
      <form action={run}>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner />}
          Create API key
        </Button>
      </form>
      {state.secret ? (
        <SecretOnce label="Your new API key" secret={state.secret} />
      ) : (
        <FormMessage state={state} />
      )}
    </div>
  );
}
