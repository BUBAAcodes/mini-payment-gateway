import type { ActionState } from '@/lib/action-state';
import { cn } from '@/lib/utils';

/** What the last submit did, announced to screen readers. */
export function FormMessage({ state, className }: { state: ActionState; className?: string }) {
  return (
    <p
      role={state.status === 'error' ? 'alert' : 'status'}
      className={cn(
        'text-sm',
        state.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
        className,
      )}
    >
      {state.status === 'idle' ? '' : state.message}
    </p>
  );
}
