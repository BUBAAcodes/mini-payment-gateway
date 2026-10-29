import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@gateway/shared';
import type { PrismaClient } from '@gateway/db';
import { createMerchant, createOrder, createPayment, testPrisma } from '@gateway/db/testing';
import { createFakeBank, type AuthorizeRequest, type BankClient } from '../src/fake-bank';

const SLOW_MS = 20_000;

let db: PrismaClient;
let clock: Date;
let bank: BankClient;

beforeAll(() => {
  db = testPrisma();
  // No real waiting for normal answers; a clock the tests move by hand.
  bank = createFakeBank(db, { normalDelayMs: 0, slowDelayMs: SLOW_MS, now: () => clock });
});

beforeEach(() => {
  clock = new Date('2020-01-01T10:00:00+05:30');
});

afterAll(async () => {
  await db.$disconnect();
});

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

const upi = (vpa: string, gatewayReference = newId('pay')): AuthorizeRequest => ({
  gatewayReference,
  amount: 50_000,
  method: 'upi',
  vpa,
});

const card = (cardLast4: string, otp = '123456'): AuthorizeRequest => ({
  gatewayReference: newId('pay'),
  amount: 50_000,
  method: 'card',
  cardLast4,
  otp,
});

const bankRow = (gatewayReference: string) =>
  db.bankTransaction.findFirstOrThrow({ where: { gatewayReference } });

describe('authorize', () => {
  it.each<[string, AuthorizeRequest, 'approved' | 'declined', string | null]>([
    ['success@test', upi('success@test'), 'approved', null],
    ['fail@test', upi('fail@test'), 'declined', 'insufficient_funds'],
    ['an unknown VPA', upi('nobody@okbank'), 'declined', 'invalid_vpa'],
    ['card 1111 with OTP 123456', card('1111'), 'approved', null],
    ['card 1111 with a wrong OTP', card('1111', '000000'), 'declined', 'otp_invalid'],
    ['card 0002', card('0002'), 'declined', 'card_declined'],
  ])('%s', async (_name, request, status, declineReason) => {
    const answer = await bank.authorize(request);

    expect(answer).toEqual({
      bankRef: expect.stringMatching(/^bank_[0-9A-Za-z]{14}$/),
      status,
      declineReason,
    });
    expect(await bankRow(request.gatewayReference)).toMatchObject({
      bankRef: answer.bankRef,
      type: 'payment',
      amount: 50_000,
      outcome: status,
      declineReason,
      decidedAt: clock,
      callbackSent: true,
    });
    await expect(bank.getStatus(request.gatewayReference)).resolves.toEqual(answer);
  });

  it('slow@test: our timeout fires first, then a status check finds the answer', async () => {
    const request = upi('slow@test');

    await expect(
      bank.authorize(request, { signal: AbortSignal.timeout(20) }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // The bank still has the request and will decide it later. Timeout means unknown, not failed.
    const row = await bankRow(request.gatewayReference);
    expect(row).toMatchObject({
      outcome: 'approved',
      decidedAt: new Date(clock.getTime() + SLOW_MS),
    });
    await expect(bank.getStatus(request.gatewayReference)).resolves.toEqual({
      bankRef: row.bankRef,
      status: 'pending',
      declineReason: null,
    });

    advance(SLOW_MS);
    await expect(bank.getStatus(request.gatewayReference)).resolves.toEqual({
      bankRef: row.bankRef,
      status: 'approved',
      declineReason: null,
    });
  });

  it('lost@test: approves in its own records but tells us "pending" forever', async () => {
    const request = upi('lost@test');

    const answer = await bank.authorize(request);
    expect(answer.status).toBe('pending');
    expect(await bankRow(request.gatewayReference)).toMatchObject({
      outcome: 'approved',
      callbackSent: false,
    });

    advance(60 * 60_000);
    await expect(bank.getStatus(request.gatewayReference)).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('a repeated request for the same payment returns the original record', async () => {
    const request = upi('success@test');

    const first = await bank.authorize(request);
    const second = await bank.authorize(upi('fail@test', request.gatewayReference));

    expect(second).toEqual(first);
    expect(
      await db.bankTransaction.count({ where: { gatewayReference: request.gatewayReference } }),
    ).toBe(1);
  });

  it('records nothing when the call is cancelled before it starts', async () => {
    const request = upi('success@test');
    const controller = new AbortController();
    controller.abort();

    await expect(bank.authorize(request, { signal: controller.signal })).rejects.toThrow();
    expect(
      await db.bankTransaction.count({ where: { gatewayReference: request.gatewayReference } }),
    ).toBe(0);
  });
});

describe('getStatus', () => {
  it('answers not_found for a reference the bank never saw', async () => {
    await expect(bank.getStatus(newId('pay'))).resolves.toEqual({ status: 'not_found' });
  });
});

describe('refund', () => {
  async function capturedPayment(notes?: { fail_refund: boolean }) {
    const merchant = await createMerchant(db);
    const order = await createOrder(db, merchant.id);
    if (notes) await db.order.update({ where: { id: order.id }, data: { notes } });
    return createPayment(db, order, 'captured');
  }

  it('approves a refund and keeps its own record of it', async () => {
    const payment = await capturedPayment();
    const refundId = newId('rfnd');

    const answer = await bank.refund({
      gatewayReference: refundId,
      paymentReference: payment.id,
      amount: 20_000,
    });

    expect(answer).toMatchObject({ status: 'approved', declineReason: null });
    expect(await bankRow(refundId)).toMatchObject({
      type: 'refund',
      amount: 20_000,
      outcome: 'approved',
    });
    await expect(bank.getStatus(refundId)).resolves.toEqual(answer);
  });

  it('declines when the order notes say "fail_refund": true', async () => {
    const payment = await capturedPayment({ fail_refund: true });

    const answer = await bank.refund({
      gatewayReference: newId('rfnd'),
      paymentReference: payment.id,
      amount: 20_000,
    });

    expect(answer).toMatchObject({ status: 'declined', declineReason: 'refund_declined' });
  });
});

describe('settlementFile', () => {
  it("lists the day's decided transactions in India time, including the lost one", async () => {
    // Placed on a date no other test uses, so their rows can't leak into the file.
    clock = new Date('2020-03-14T23:59:59+05:30');
    await bank.authorize(upi('success@test', 'pay_daybefore'));

    clock = new Date('2020-03-15T09:00:00+05:30');
    const success = await bank.authorize(upi('success@test', 'pay_success'));
    advance(1000);
    const failed = await bank.authorize(upi('fail@test', 'pay_failed'));
    advance(1000);
    const lost = await bank.authorize(upi('lost@test', 'pay_lost'));
    advance(1000);
    await bank
      .authorize(upi('slow@test', 'pay_slow'), { signal: AbortSignal.timeout(10) })
      .catch(() => {});
    advance(1000);
    const refund = await bank.refund({
      gatewayReference: 'rfnd_refund',
      paymentReference: 'pay_success',
      amount: 10_000,
    });

    // The slow payment is still undecided when the file is cut.
    const csv = await bank.settlementFile('2020-03-15');

    expect(csv).toBe(
      [
        'bank_ref,gateway_reference,type,amount,status,bank_date',
        `${success.bankRef},pay_success,payment,50000,success,2020-03-15`,
        `${failed.bankRef},pay_failed,payment,50000,failed,2020-03-15`,
        `${lost.bankRef},pay_lost,payment,50000,success,2020-03-15`,
        `${refund.bankRef},rfnd_refund,refund,10000,success,2020-03-15`,
        '',
      ].join('\n'),
    );

    // Once the slow payment is decided, it shows up too.
    advance(SLOW_MS);
    expect(await bank.settlementFile('2020-03-15')).toContain('pay_slow,payment,50000,success');
    expect(await bank.settlementFile('2020-03-14')).toContain('pay_daybefore');
  });
});
