// Plain helpers and types for the checkout page. Client components import this file, so it must
// not import @gateway/shared (which pulls in node:crypto) or anything server-only.

export const BRAND_NAME = 'Mini Gateway';

export type PaymentStatus =
  'created' | 'otp_required' | 'pending' | 'authorized' | 'captured' | 'refunded' | 'failed';

/** GET /checkout/orders/:id. */
export interface CheckoutOrder {
  id: string;
  amount: number;
  currency: string;
  status: 'created' | 'attempted' | 'paid';
  merchant_name: string;
  latest_payment: { id: string; status: PaymentStatus } | null;
}

/** A payment as the checkout API returns it, with where to send the customer when it's over. */
export interface CheckoutPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  method: 'upi' | 'card';
  vpa: string | null;
  card_last4: string | null;
  card_network: string | null;
  status: PaymentStatus;
  failure_reason: string | null;
  redirect_url: string | null;
}

/** The API's error shape (section 7). */
export interface ApiError {
  code: string;
  message: string;
  field?: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export type Screen = 'form' | 'otp' | 'processing' | 'success' | 'failure';

/** Which screen a payment attempt puts the customer on. No attempt yet: the payment form. */
export function screenFor(payment: Pick<CheckoutPayment, 'status'> | null): Screen {
  if (!payment) return 'form';
  switch (payment.status) {
    case 'otp_required':
      return 'otp';
    case 'created':
    case 'pending':
    case 'authorized':
      return 'processing';
    case 'captured':
    case 'refunded':
      return 'success';
    case 'failed':
      return 'failure';
  }
}

export interface ProgressStep {
  label: 'Details' | 'Verify' | 'Done';
  state: 'done' | 'current' | 'todo' | 'failed';
}

/**
 * The checkout's progress line. Three steps whatever the method, so it never changes shape
 * partway: Verify is the OTP for cards and the bank's approval for UPI.
 */
export function progressSteps(screen: Screen): ProgressStep[] {
  const current = { form: 0, otp: 1, processing: 1, success: 3, failure: 3 }[screen];
  return (['Details', 'Verify', 'Done'] as const).map((label, i) => ({
    label,
    state:
      screen === 'failure' && i === 2
        ? 'failed'
        : i < current
          ? 'done'
          : i === current
            ? 'current'
            : 'todo',
  }));
}

const FAILURE_MESSAGES: Record<string, string> = {
  insufficient_funds: 'Your bank declined the payment: insufficient funds.',
  card_declined: 'Your card was declined.',
  otp_invalid: 'The OTP was not correct.',
  bank_timeout: 'Your bank did not respond in time.',
};

/** The bank's failure reason in plain words. */
export function failureMessage(reason: string | null): string {
  return (reason && FAILURE_MESSAGES[reason]) || 'The payment could not be completed.';
}

/** Reads an expiry typed as MM/YY, MM/YYYY or MMYY. Null if it isn't a real month and year. */
export function parseExpiry(value: string): { month: number; year: number } | null {
  const match = /^(\d{2})\s*\/?\s*(\d{2}|\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = Number(match[1]);
  const year = match[2]!.length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  return month >= 1 && month <= 12 ? { month, year } : null;
}

/** Formats the expiry field as the customer types: "1227" → "12/27". */
export function formatExpiryInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

export const OTP_LENGTH = 6;

/** What the OTP field accepts, typed or pasted: digits only, at most six. */
export function otpDigits(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, OTP_LENGTH);
}

/** Groups a card number in fours as the customer types. Card numbers have at most 19 digits. */
export function formatCardNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 19);
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** How the customer paid, as shown on screen. Cards only ever show their last four digits. */
export function paymentMethodLabel(
  payment: Pick<CheckoutPayment, 'method' | 'vpa' | 'card_last4'>,
): string {
  return payment.method === 'upi'
    ? `UPI · ${payment.vpa ?? ''}`
    : `Card •••• ${payment.card_last4 ?? ''}`;
}
