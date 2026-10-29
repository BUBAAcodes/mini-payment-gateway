import { describe, expect, it } from 'vitest';
import type { AuthorizeRequest } from './bank-client';
import { decideAuthorization, decideRefund, type Decision } from './scenarios';

const upi = (vpa: string): AuthorizeRequest => ({
  gatewayReference: 'pay_x',
  amount: 50_000,
  method: 'upi',
  vpa,
});
const card = (cardLast4: string, otp: string): AuthorizeRequest => ({
  gatewayReference: 'pay_x',
  amount: 50_000,
  method: 'card',
  cardLast4,
  otp,
});

const approved: Decision = {
  outcome: 'approved',
  declineReason: null,
  delay: 'normal',
  tellsGateway: true,
};
const declined = (declineReason: string): Decision => ({
  outcome: 'declined',
  declineReason,
  delay: 'normal',
  tellsGateway: true,
});

describe('decideAuthorization', () => {
  it.each<[string, AuthorizeRequest, Decision]>([
    ['success@test approves', upi('success@test'), approved],
    ['fail@test declines', upi('fail@test'), declined('insufficient_funds')],
    ['slow@test approves, slowly', upi('slow@test'), { ...approved, delay: 'slow' }],
    [
      'lost@test approves but never tells us',
      upi('lost@test'),
      { ...approved, tellsGateway: false },
    ],
    ['VPAs are case-insensitive', upi('Success@Test'), approved],
    ['an unknown VPA declines', upi('someone@okbank'), declined('invalid_vpa')],
    ['card 1111 with the right OTP approves', card('1111', '123456'), approved],
    ['card 0002 with the right OTP declines', card('0002', '123456'), declined('card_declined')],
    ['another card declines', card('4444', '123456'), declined('card_declined')],
    ['a wrong OTP fails', card('1111', '654321'), declined('otp_invalid')],
    ['the OTP is checked before the card', card('0002', '000000'), declined('otp_invalid')],
    ['an empty OTP fails', card('1111', ''), declined('otp_invalid')],
  ])('%s', (_name, request, decision) => {
    expect(decideAuthorization(request)).toEqual(decision);
  });
});

describe('decideRefund', () => {
  it('approves refunds', () => {
    expect(decideRefund({ failRefund: false })).toEqual(approved);
  });

  it('declines when the order asked for a failing refund', () => {
    expect(decideRefund({ failRefund: true })).toEqual(declined('refund_declined'));
  });
});
