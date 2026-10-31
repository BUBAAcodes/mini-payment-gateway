import {
  istDayStart,
  type PaymentResponse,
  type ReconciliationIssueResponse,
} from '@gateway/shared';

// Display helpers for dashboard pages. Server code only: @gateway/shared pulls in node:crypto, so
// Client Components get already-formatted strings from their page instead of importing this.

export type Tone = 'success' | 'danger' | 'waiting' | 'neutral';

const TONES: Record<string, Tone> = {
  captured: 'success',
  succeeded: 'success',
  processed: 'success',
  paid: 'success',
  failed: 'danger',
  refunded: 'neutral',
};

/** How a payment, refund or delivery status is coloured. Anything still moving is "waiting". */
export function statusTone(status: string): Tone {
  return TONES[status] ?? 'waiting';
}

/** "otp_required" → "otp required". */
export function statusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

const dateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** A timestamp in India time, e.g. "30 Oct 2026, 17:30". */
export function formatDateTime(iso: string | null): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

/** 0.975 → "97.5%". */
export function formatPercent(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 1000) / 10}%`;
}

const NETWORKS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  rupay: 'RuPay',
  amex: 'Amex',
};

/** "UPI · success@test" or "Visa •••• 1111". Only the last four digits ever exist (rule 9). */
export function methodSummary(
  payment: Pick<PaymentResponse, 'method' | 'vpa' | 'card_last4' | 'card_network'>,
): string {
  if (payment.method === 'upi') return `UPI · ${payment.vpa ?? ''}`;
  const network = NETWORKS[payment.card_network ?? ''] ?? 'Card';
  return `${network} •••• ${payment.card_last4 ?? ''}`;
}

const KINDS: Record<ReconciliationIssueResponse['kind'], string> = {
  missing_in_gateway: 'Only in the bank file',
  missing_in_bank: 'Missing from the bank file',
  amount_mismatch: 'Amount differs',
  status_mismatch: 'Status differs',
};

export function reconciliationKindLabel(kind: ReconciliationIssueResponse['kind']): string {
  return KINDS[kind];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export type DateRange =
  { ok: true; from: string | undefined; to: string | undefined } | { ok: false; message: string };

/**
 * The payments filter's two dates (YYYY-MM-DD, India time) as the API's [from, to) instants.
 * "to" includes that whole day. Empty dates are left out.
 */
export function paymentDateRange(from: string | undefined, to: string | undefined): DateRange {
  try {
    const start = from ? istDayStart(from) : undefined;
    const end = to ? new Date(istDayStart(to).getTime() + DAY_MS) : undefined;
    if (start && end && start >= end) {
      return { ok: false, message: 'The "to" date is before the "from" date' };
    }
    return { ok: true, from: start?.toISOString(), to: end?.toISOString() };
  } catch {
    return { ok: false, message: 'Dates must be real dates, like 2026-10-29' };
  }
}
