'use client';

import { useActionState, useState, type ComponentProps } from 'react';
import { Spinner } from '@/components/checkout/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { ActionState, KeyedState } from '@/lib/action-state';
import { FormMessage } from './form-message';

type Variant = ComponentProps<typeof Button>['variant'];

interface ActionButtonProps<S extends ActionState> {
  /** A Server Action with its target ID already bound. */
  action: (state: S, formData: FormData) => Promise<S>;
  label: string;
  pendingLabel?: string;
  variant?: Variant;
  /** Set for actions that send an Idempotency-Key: the key the page rendered. */
  idempotencyKey?: string;
  /** Asks first, in a dialog, for actions that can't be undone. */
  confirm?: { title: string; description: string; confirmLabel: string };
}

/** One button that runs one Server Action, and says what happened next to it. */
export function ActionButton<S extends ActionState>({
  action,
  label,
  pendingLabel = label,
  variant = 'outline',
  idempotencyKey,
  confirm,
}: ActionButtonProps<S>) {
  const initial = (idempotencyKey ? { status: 'idle', idempotencyKey } : { status: 'idle' }) as S;
  // S is a plain state object, never a promise, so Awaited<S> is S; React's types can't see that
  // for a generic S.
  const [state, run, pending] = useActionState(
    action as (state: Awaited<S>, formData: FormData) => Promise<S>,
    initial as Awaited<S>,
  );
  const [open, setOpen] = useState(false);
  const key = (state as Partial<KeyedState>).idempotencyKey;

  const form = (
    <form
      action={(formData) => {
        setOpen(false);
        return run(formData);
      }}
    >
      {key && <input type="hidden" name="idempotency_key" value={key} />}
      <Button
        type="submit"
        size="sm"
        variant={confirm ? 'destructive' : variant}
        disabled={pending}
      >
        {pending && <Spinner className="size-3" />}
        {pending ? pendingLabel : (confirm?.confirmLabel ?? label)}
      </Button>
    </form>
  );

  return (
    <div className="flex flex-col items-start gap-1">
      {confirm ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant={variant} disabled={pending}>
              {pending && <Spinner className="size-3" />}
              {pending ? pendingLabel : label}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{confirm.title}</DialogTitle>
              <DialogDescription>{confirm.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button size="sm" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              {form}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : (
        form
      )}
      <FormMessage state={state} className="max-w-56 text-xs" />
    </div>
  );
}
