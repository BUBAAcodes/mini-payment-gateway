import type { ReactNode } from 'react';

// Small building blocks in the store reference's style: black buttons with a 6px radius, grey
// uppercase eyebrows, hairline inputs. Plain Tailwind until shadcn/ui arrives in step 20.

/** Each screen's heading carries this ID; the flow moves focus to it when the screen changes. */
export const SCREEN_HEADING_ID = 'checkout-screen-heading';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

const buttonBase =
  'inline-flex items-center justify-center gap-2 rounded-control px-5 py-3 text-base font-medium transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60';

export const buttonStyles = {
  primary: cx(buttonBase, 'bg-primary text-primary-foreground hover:opacity-85'),
  secondary: cx(buttonBase, 'border border-foreground text-foreground hover:bg-muted'),
};

export const inputStyles =
  'w-full rounded-control border border-input bg-background px-3.5 py-3 text-base text-foreground placeholder:text-muted-foreground/70 focus:border-foreground focus:outline-none aria-invalid:border-destructive';

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cx(
        'text-sm font-semibold tracking-[0.04em] text-muted-foreground uppercase',
        className,
      )}
    >
      {children}
    </p>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent',
        className,
      )}
    />
  );
}

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}

/** A label, its input and the API's error for that field. Pass aria-describedby={errorId(id)}. */
export function Field({ id, label, error, children }: FieldProps) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {error && (
        <p id={errorId(id)} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export const errorId = (fieldId: string) => `${fieldId}-error`;
