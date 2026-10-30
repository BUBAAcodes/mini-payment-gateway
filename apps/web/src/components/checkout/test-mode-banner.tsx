/**
 * Always visible on checkout, the dark OTP page included (rule 13). Styled after the black ticker
 * band in the store reference.
 */
export function TestModeBanner() {
  return (
    <div
      role="note"
      className="sticky top-0 z-50 bg-primary px-4 py-3 text-center text-xs font-semibold tracking-[0.18em] text-primary-foreground uppercase"
    >
      Test mode <span aria-hidden="true">·</span> Never enter real card details
    </div>
  );
}
