'use client';

import { Fragment, useId, useState } from 'react';
import { OTP_LENGTH, otpDigits } from '@/lib/checkout';
import { cx } from './ui';

interface OtpBoxesProps {
  value: string;
  onChange: (value: string) => void;
  /** Called once all six digits are in, typed or pasted. */
  onComplete: (value: string) => void;
  disabled?: boolean;
  describedBy?: string;
}

/**
 * The reference's access-code input: six boxes split 3-3, with a blinking caret in the next empty
 * box. One real (invisible) input sits on top of the boxes, so typing, pasting, autofill of SMS
 * codes and screen readers all work as they do for a normal field.
 */
export function OtpBoxes({ value, onChange, onComplete, disabled, describedBy }: OtpBoxesProps) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const activeIndex = Math.min(value.length, OTP_LENGTH - 1);

  return (
    <div className="relative w-max max-w-full">
      <label htmlFor={id} className="sr-only">
        One-time password
      </label>
      <input
        id={id}
        data-autofocus
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => {
          const digits = otpDigits(event.target.value);
          onChange(digits);
          if (digits.length === OTP_LENGTH) onComplete(digits);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="absolute inset-0 z-10 size-full cursor-text border-0 bg-transparent text-transparent caret-transparent opacity-0 outline-none"
      />
      <div aria-hidden="true" className="flex items-center gap-2 sm:gap-2.5">
        {Array.from({ length: OTP_LENGTH }, (_, i) => {
          const digit = value[i];
          const active = focused && !disabled && i === activeIndex;
          return (
            <Fragment key={i}>
              {i === OTP_LENGTH / 2 && (
                <span className="h-0.5 w-1.5 shrink-0 rounded-[1px] bg-bank-foreground/22" />
              )}
              <div
                style={{ animationDelay: `${i * 45}ms` }}
                className={cx(
                  'relative flex h-14 w-11 animate-rise-in items-center justify-center rounded-otp border bg-bank-panel text-[22px] leading-none font-semibold tracking-[0.06em] text-bank-foreground tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_8px_20px_rgba(0,0,0,0.35),0_1px_3px_rgba(0,0,0,0.25)] transition-colors sm:w-12',
                  active ? 'border-bank-accent/70' : 'border-bank-foreground/12',
                  disabled && 'opacity-60',
                )}
              >
                {digit ??
                  (active && (
                    <span className="h-[1.15em] w-[1.5px] animate-caret-blink rounded-[1px] bg-bank-accent" />
                  ))}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
