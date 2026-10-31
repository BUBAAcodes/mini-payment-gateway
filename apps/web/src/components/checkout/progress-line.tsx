import { Check, X } from 'lucide-react';
import { progressSteps, type Screen } from '@/lib/checkout';
import { cx } from './ui';

/** Details → Verify → Done, above the checkout panel. */
export function ProgressLine({ screen }: { screen: Screen }) {
  const steps = progressSteps(screen);
  return (
    <ol aria-label="Payment progress" className="mb-6 flex items-center gap-2 text-xs font-medium">
      {steps.map((step, i) => (
        <li
          key={step.label}
          aria-current={step.state === 'current' ? 'step' : undefined}
          className="flex flex-1 items-center gap-2"
        >
          <span
            className={cx(
              'flex size-6 shrink-0 items-center justify-center rounded-full border font-pill tabular-nums',
              step.state === 'done' && 'border-foreground bg-foreground text-background',
              step.state === 'current' && 'border-foreground text-foreground',
              step.state === 'todo' && 'border-border text-muted-foreground',
              step.state === 'failed' && 'border-destructive bg-destructive text-white',
            )}
          >
            {step.state === 'done' ? (
              <Check aria-hidden="true" className="size-3.5" />
            ) : step.state === 'failed' ? (
              <X aria-hidden="true" className="size-3.5" />
            ) : (
              i + 1
            )}
          </span>
          <span
            className={cx(
              'tracking-[0.04em] uppercase',
              step.state === 'todo' ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {step.label}
            <span className="sr-only">
              {step.state === 'done'
                ? ' (done)'
                : step.state === 'current'
                  ? ' (current step)'
                  : step.state === 'failed'
                    ? ' (failed)'
                    : ''}
            </span>
          </span>
          {i < steps.length - 1 && (
            <span
              aria-hidden="true"
              className={cx('h-px flex-1', step.state === 'done' ? 'bg-foreground' : 'bg-border')}
            />
          )}
        </li>
      ))}
    </ol>
  );
}
