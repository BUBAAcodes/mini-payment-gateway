'use client';

import { useActionState, useState } from 'react';
import { Spinner } from '@/components/checkout/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { KeyedState, SecretState } from '@/lib/action-state';
import { FormMessage } from './form-message';
import { SecretOnce } from './secret-once';

type State = KeyedState & SecretState;

interface WebhookFormProps {
  action: (state: State, formData: FormData) => Promise<State>;
  idempotencyKey: string;
  /** WEBHOOK_EVENT_TYPES, passed in so this file doesn't import @gateway/shared. */
  eventTypes: readonly string[];
}

export function WebhookForm({ action, idempotencyKey, eventTypes }: WebhookFormProps) {
  const [state, run, pending] = useActionState(action, { status: 'idle', idempotencyKey });
  const [allEvents, setAllEvents] = useState(true);
  const error = (field: string) => state.status === 'error' && state.field === field;

  return (
    <div className="space-y-4">
      <form action={run} className="space-y-5">
        <input type="hidden" name="idempotency_key" value={state.idempotencyKey} />
        <div className="space-y-2">
          <Label htmlFor="webhook-url">Endpoint URL</Label>
          <Input
            id="webhook-url"
            name="url"
            type="url"
            required
            placeholder="https://your-shop.example/webhooks/gateway"
            aria-invalid={error('url')}
          />
        </div>
        <fieldset className="space-y-3" aria-invalid={error('event_types')}>
          <legend className="mb-3 text-sm font-medium">Events to send</legend>
          <div className="flex items-center gap-2">
            <Checkbox
              id="all-events"
              name="all_events"
              checked={allEvents}
              onCheckedChange={(checked) => setAllEvents(checked === true)}
            />
            <Label htmlFor="all-events">All events, including ones added later</Label>
          </div>
          <div className="grid gap-2 pl-6 sm:grid-cols-2">
            {eventTypes.map((type) => (
              <div key={type} className="flex items-center gap-2">
                <Checkbox
                  id={`type-${type}`}
                  name="event_types"
                  value={type}
                  disabled={allEvents}
                />
                <Label htmlFor={`type-${type}`} className="font-mono text-xs">
                  {type}
                </Label>
              </div>
            ))}
          </div>
        </fieldset>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner />}
          Add endpoint
        </Button>
      </form>
      {state.secret ? (
        <SecretOnce label="Signing secret for this endpoint" secret={state.secret} />
      ) : (
        <FormMessage state={state} />
      )}
    </div>
  );
}
