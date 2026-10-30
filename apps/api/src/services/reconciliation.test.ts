import { describe, expect, it } from 'vitest';
import type { BankFileRow } from '../fake-bank/settlement-file';
import { compareRecords, type GatewayRecord } from './reconciliation';

const MERCHANT = 'mer_A';

function bankRow(overrides: Partial<BankFileRow> = {}): BankFileRow {
  return {
    bankRef: 'bank_1',
    gatewayReference: 'pay_1',
    type: 'payment',
    amount: 50_000,
    status: 'success',
    ...overrides,
  };
}

function ours(overrides: Partial<GatewayRecord> = {}): GatewayRecord {
  return {
    id: 'pay_1',
    merchantId: MERCHANT,
    type: 'payment',
    amount: 50_000,
    status: 'captured',
    ...overrides,
  };
}

describe('compareRecords', () => {
  it('finds nothing when both sides agree', () => {
    const issues = compareRecords({
      bankRows: [
        bankRow(),
        bankRow({ bankRef: 'bank_2', gatewayReference: 'pay_2', status: 'failed' }),
        bankRow({ bankRef: 'bank_3', gatewayReference: 'pay_3' }),
        bankRow({ bankRef: 'bank_4', gatewayReference: 'rfnd_1', type: 'refund', amount: 100 }),
        bankRow({
          bankRef: 'bank_5',
          gatewayReference: 'rfnd_2',
          type: 'refund',
          status: 'failed',
        }),
      ],
      ours: [
        ours(),
        ours({ id: 'pay_2', status: 'failed' }),
        // Refunded later: the bank still approved the payment itself.
        ours({ id: 'pay_3', status: 'refunded' }),
        ours({ id: 'rfnd_1', type: 'refund', amount: 100, status: 'processed' }),
        ours({ id: 'rfnd_2', type: 'refund', status: 'failed' }),
      ],
      expected: [ours(), ours({ id: 'rfnd_1', type: 'refund', amount: 100, status: 'processed' })],
      onOtherFiles: new Set(),
    });
    expect(issues).toEqual([]);
  });

  it('lost@test: the bank approved a payment we gave up on', () => {
    const issues = compareRecords({
      bankRows: [bankRow()],
      ours: [ours({ status: 'failed' })],
      expected: [],
      onOtherFiles: new Set(),
    });
    expect(issues).toEqual([
      {
        kind: 'status_mismatch',
        merchantId: MERCHANT,
        gatewayReference: 'pay_1',
        bankRef: 'bank_1',
        details: { type: 'payment', bank_status: 'success', gateway_status: 'failed' },
      },
    ]);
  });

  it('flags a payment we still hold as pending once the bank has approved it', () => {
    const issues = compareRecords({
      bankRows: [bankRow()],
      ours: [ours({ status: 'pending' })],
      expected: [],
      onOtherFiles: new Set(),
    });
    expect(issues).toMatchObject([
      { kind: 'status_mismatch', details: { gateway_status: 'pending' } },
    ]);
  });

  it('flags a refund the bank failed but we processed', () => {
    const refund = ours({ id: 'rfnd_1', type: 'refund', status: 'processed' });
    const issues = compareRecords({
      bankRows: [bankRow({ gatewayReference: 'rfnd_1', type: 'refund', status: 'failed' })],
      ours: [refund],
      expected: [refund],
      onOtherFiles: new Set(),
    });
    expect(issues).toMatchObject([
      {
        kind: 'status_mismatch',
        gatewayReference: 'rfnd_1',
        details: { type: 'refund', bank_status: 'failed', gateway_status: 'processed' },
      },
    ]);
  });

  it('flags a bank row we have no record of, with no merchant', () => {
    const issues = compareRecords({
      bankRows: [bankRow({ gatewayReference: 'pay_unknown' })],
      ours: [],
      expected: [],
      onOtherFiles: new Set(),
    });
    expect(issues).toEqual([
      {
        kind: 'missing_in_gateway',
        merchantId: null,
        gatewayReference: 'pay_unknown',
        bankRef: 'bank_1',
        details: { type: 'payment', amount: 50_000, bank_status: 'success' },
      },
    ]);
  });

  it('matches on type as well as ID', () => {
    const issues = compareRecords({
      bankRows: [bankRow({ type: 'refund' })],
      ours: [ours()],
      expected: [],
      onOtherFiles: new Set(),
    });
    expect(issues).toMatchObject([{ kind: 'missing_in_gateway', gatewayReference: 'pay_1' }]);
  });

  it('flags different amounts, and a different status as well when both differ', () => {
    const issues = compareRecords({
      bankRows: [bankRow({ amount: 49_000 })],
      ours: [ours({ status: 'failed' })],
      expected: [],
      onOtherFiles: new Set(),
    });
    expect(issues).toEqual([
      {
        kind: 'amount_mismatch',
        merchantId: MERCHANT,
        gatewayReference: 'pay_1',
        bankRef: 'bank_1',
        details: { type: 'payment', bank_amount: 49_000, gateway_amount: 50_000 },
      },
      expect.objectContaining({ kind: 'status_mismatch' }),
    ]);
  });

  it('flags our captures and processed refunds that are on no bank file', () => {
    const refund = ours({ id: 'rfnd_1', type: 'refund', amount: 100, status: 'processed' });
    const issues = compareRecords({
      bankRows: [],
      ours: [],
      expected: [ours(), refund],
      onOtherFiles: new Set(),
    });
    expect(issues).toEqual([
      {
        kind: 'missing_in_bank',
        merchantId: MERCHANT,
        gatewayReference: 'pay_1',
        bankRef: null,
        details: { type: 'payment', amount: 50_000, gateway_status: 'captured' },
      },
      {
        kind: 'missing_in_bank',
        merchantId: MERCHANT,
        gatewayReference: 'rfnd_1',
        bankRef: null,
        details: { type: 'refund', amount: 100, gateway_status: 'processed' },
      },
    ]);
  });

  it("doesn't flag ours when the bank put it on another day's file (around midnight)", () => {
    const issues = compareRecords({
      bankRows: [],
      ours: [],
      expected: [ours()],
      onOtherFiles: new Set(['payment:pay_1']),
    });
    expect(issues).toEqual([]);
  });
});
