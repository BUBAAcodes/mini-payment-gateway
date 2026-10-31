import { describe, expect, it } from 'vitest';
import {
  failureMessage,
  formatCardNumber,
  formatExpiryInput,
  otpDigits,
  parseExpiry,
  paymentMethodLabel,
  progressSteps,
  screenFor,
  type PaymentStatus,
} from './checkout';

describe('screenFor', () => {
  it('shows the payment form when there is no attempt yet', () => {
    expect(screenFor(null)).toBe('form');
  });

  it.each<[PaymentStatus, ReturnType<typeof screenFor>]>([
    ['otp_required', 'otp'],
    ['created', 'processing'],
    ['pending', 'processing'],
    ['authorized', 'processing'],
    ['captured', 'success'],
    ['refunded', 'success'],
    ['failed', 'failure'],
  ])('a %s payment shows the %s screen', (status, screen) => {
    expect(screenFor({ status })).toBe(screen);
  });
});

describe('failureMessage', () => {
  it.each([
    ['insufficient_funds', 'Your bank declined the payment: insufficient funds.'],
    ['card_declined', 'Your card was declined.'],
    ['otp_invalid', 'The OTP was not correct.'],
    ['bank_timeout', 'Your bank did not respond in time.'],
  ])('explains %s in plain words', (reason, message) => {
    expect(failureMessage(reason)).toBe(message);
  });

  it('falls back to a general message for reasons it does not know', () => {
    expect(failureMessage('something_new')).toBe('The payment could not be completed.');
    expect(failureMessage(null)).toBe('The payment could not be completed.');
  });
});

describe('parseExpiry', () => {
  it('reads MM/YY as a month and a four-digit year', () => {
    expect(parseExpiry('12/27')).toEqual({ month: 12, year: 2027 });
    expect(parseExpiry(' 03 / 29 ')).toEqual({ month: 3, year: 2029 });
  });

  it('also reads MM/YYYY and MMYY', () => {
    expect(parseExpiry('07/2031')).toEqual({ month: 7, year: 2031 });
    expect(parseExpiry('0728')).toEqual({ month: 7, year: 2028 });
  });

  it('refuses months outside 1–12 and anything that is not a date', () => {
    for (const value of ['00/27', '13/27', '1/2', '', 'ab/cd', '12/2']) {
      expect(parseExpiry(value)).toBeNull();
    }
  });
});

describe('formatExpiryInput', () => {
  it('adds the slash after the month as the customer types', () => {
    expect(formatExpiryInput('1')).toBe('1');
    expect(formatExpiryInput('12')).toBe('12');
    expect(formatExpiryInput('122')).toBe('12/2');
    expect(formatExpiryInput('12/27')).toBe('12/27');
    expect(formatExpiryInput('12279')).toBe('12/27');
  });
});

describe('otpDigits', () => {
  it('keeps only digits, at most six', () => {
    expect(otpDigits('123456')).toBe('123456');
    expect(otpDigits(' 12-34 56 ')).toBe('123456');
    expect(otpDigits('1234567890')).toBe('123456');
    expect(otpDigits('abc')).toBe('');
  });
});

describe('formatCardNumber', () => {
  it('groups digits in fours and drops everything else', () => {
    expect(formatCardNumber('4111111111111111')).toBe('4111 1111 1111 1111');
    expect(formatCardNumber('4111-1111 11')).toBe('4111 1111 11');
  });

  it('stops at 19 digits, the longest card number', () => {
    expect(formatCardNumber('1'.repeat(25)).replace(/ /g, '')).toHaveLength(19);
  });
});

describe('paymentMethodLabel', () => {
  it('names the UPI ID or the last four card digits, never more of the card', () => {
    expect(paymentMethodLabel({ method: 'upi', vpa: 'success@test', card_last4: null })).toBe(
      'UPI · success@test',
    );
    expect(paymentMethodLabel({ method: 'card', vpa: null, card_last4: '1111' })).toBe(
      'Card •••• 1111',
    );
  });
});

describe('progressSteps', () => {
  const states = (screen: Parameters<typeof progressSteps>[0]) =>
    progressSteps(screen).map((step) => `${step.label}:${step.state}`);

  it('walks Details → Verify → Done', () => {
    expect(states('form')).toEqual(['Details:current', 'Verify:todo', 'Done:todo']);
    expect(states('otp')).toEqual(['Details:done', 'Verify:current', 'Done:todo']);
    expect(states('processing')).toEqual(['Details:done', 'Verify:current', 'Done:todo']);
    expect(states('success')).toEqual(['Details:done', 'Verify:done', 'Done:done']);
  });

  it('marks the last step failed when the payment fails', () => {
    expect(states('failure')).toEqual(['Details:done', 'Verify:done', 'Done:failed']);
  });
});
