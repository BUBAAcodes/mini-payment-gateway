import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatPercent,
  methodSummary,
  paymentDateRange,
  reconciliationKindLabel,
  statusLabel,
  statusTone,
} from './dashboard-format';

describe('statusTone', () => {
  it('colours money that arrived, money that did not, and money in between', () => {
    expect(statusTone('captured')).toBe('success');
    expect(statusTone('succeeded')).toBe('success');
    expect(statusTone('processed')).toBe('success');
    expect(statusTone('failed')).toBe('danger');
    expect(statusTone('pending')).toBe('waiting');
    expect(statusTone('otp_required')).toBe('waiting');
    expect(statusTone('refunded')).toBe('neutral');
  });
});

describe('formatDateTime', () => {
  it('shows times in India', () => {
    expect(formatDateTime('2026-10-30T12:00:00.000Z')).toBe('30 Oct 2026, 17:30');
    expect(formatDateTime(null)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('shows a rate with one decimal, or a dash when there is none', () => {
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.975)).toBe('97.5%');
    expect(formatPercent(2 / 3)).toBe('66.7%');
    expect(formatPercent(null)).toBe('—');
  });
});

describe('methodSummary', () => {
  it('names the UPI ID or the card network and last four digits', () => {
    expect(
      methodSummary({ method: 'upi', vpa: 'success@test', card_last4: null, card_network: null }),
    ).toBe('UPI · success@test');
    expect(
      methodSummary({ method: 'card', vpa: null, card_last4: '1111', card_network: 'visa' }),
    ).toBe('Visa •••• 1111');
  });
});

describe('reconciliationKindLabel', () => {
  it('says what went wrong in words', () => {
    expect(reconciliationKindLabel('status_mismatch')).toBe('Status differs');
    expect(reconciliationKindLabel('missing_in_gateway')).toBe('Only in the bank file');
  });
});

describe('paymentDateRange', () => {
  it('turns the form dates into an IST range that includes the whole "to" day', () => {
    expect(paymentDateRange('2026-10-29', '2026-10-30')).toEqual({
      ok: true,
      from: '2026-10-28T18:30:00.000Z',
      to: '2026-10-30T18:30:00.000Z',
    });
  });

  it('leaves out an empty side', () => {
    expect(paymentDateRange('', '')).toEqual({ ok: true, from: undefined, to: undefined });
    expect(paymentDateRange(undefined, '2026-10-30')).toEqual({
      ok: true,
      from: undefined,
      to: '2026-10-30T18:30:00.000Z',
    });
  });

  it('rejects dates that do not exist, and a range that ends before it starts', () => {
    expect(paymentDateRange('2026-02-30', '')).toMatchObject({ ok: false });
    expect(paymentDateRange('2026-10-30', '2026-10-29')).toMatchObject({ ok: false });
  });
});

describe('statusLabel', () => {
  it('writes statuses in sentence case, with OTP in capitals', () => {
    expect(statusLabel('captured')).toBe('Captured');
    expect(statusLabel('otp_required')).toBe('OTP required');
    expect(statusLabel('succeeded')).toBe('Succeeded');
  });
});
