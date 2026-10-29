import { describe, expect, it } from 'vitest';
import { istDate, istDayBounds, toSettlementCsv } from './settlement-file';

describe('istDayBounds', () => {
  it('covers midnight to midnight in India (UTC+05:30)', () => {
    expect(istDayBounds('2026-10-29')).toEqual({
      start: new Date('2026-10-28T18:30:00.000Z'),
      end: new Date('2026-10-29T18:30:00.000Z'),
    });
  });

  it.each(['2026-13-01', '2026-02-30', '29-10-2026', '2026-10-29T00:00:00Z', ''])(
    'rejects %j',
    (date) => {
      expect(() => istDayBounds(date)).toThrow(RangeError);
    },
  );
});

describe('istDate', () => {
  it('puts 23:59 IST on the same day and 00:00 IST on the next', () => {
    expect(istDate(new Date('2026-10-29T18:29:59.999Z'))).toBe('2026-10-29');
    expect(istDate(new Date('2026-10-29T18:30:00.000Z'))).toBe('2026-10-30');
  });
});

describe('toSettlementCsv', () => {
  it('writes a header and one line per transaction', () => {
    const csv = toSettlementCsv('2026-10-29', [
      {
        bankRef: 'bank_A',
        gatewayReference: 'pay_1',
        type: 'payment',
        amount: 50_000,
        outcome: 'approved',
      },
      {
        bankRef: 'bank_B',
        gatewayReference: 'pay_2',
        type: 'payment',
        amount: 30_000,
        outcome: 'declined',
      },
      {
        bankRef: 'bank_C',
        gatewayReference: 'rfnd_1',
        type: 'refund',
        amount: 20_000,
        outcome: 'approved',
      },
    ]);

    expect(csv).toBe(
      [
        'bank_ref,gateway_reference,type,amount,status,bank_date',
        'bank_A,pay_1,payment,50000,success,2026-10-29',
        'bank_B,pay_2,payment,30000,failed,2026-10-29',
        'bank_C,rfnd_1,refund,20000,success,2026-10-29',
        '',
      ].join('\n'),
    );
  });

  it('writes just the header for a day with no transactions', () => {
    expect(toSettlementCsv('2026-10-29', [])).toBe(
      'bank_ref,gateway_reference,type,amount,status,bank_date\n',
    );
  });
});
