import { describe, expect, it } from 'vitest';
import { istDate, istDayBounds, parseSettlementCsv, toSettlementCsv } from './settlement-file';

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

describe('parseSettlementCsv', () => {
  const HEADER = 'bank_ref,gateway_reference,type,amount,status,bank_date';

  it('reads back what toSettlementCsv writes', () => {
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
        gatewayReference: 'rfnd_1',
        type: 'refund',
        amount: 20_000,
        outcome: 'declined',
      },
    ]);

    expect(parseSettlementCsv('2026-10-29', csv)).toEqual([
      {
        bankRef: 'bank_A',
        gatewayReference: 'pay_1',
        type: 'payment',
        amount: 50_000,
        status: 'success',
      },
      {
        bankRef: 'bank_B',
        gatewayReference: 'rfnd_1',
        type: 'refund',
        amount: 20_000,
        status: 'failed',
      },
    ]);
  });

  it('reads a file with no transactions, and tolerates CRLF line endings', () => {
    expect(parseSettlementCsv('2026-10-29', `${HEADER}\n`)).toEqual([]);
    expect(
      parseSettlementCsv(
        '2026-10-29',
        `${HEADER}\r\nbank_A,pay_1,payment,100,success,2026-10-29\r\n`,
      ),
    ).toHaveLength(1);
  });

  it('rejects a file with the wrong header', () => {
    expect(() => parseSettlementCsv('2026-10-29', 'ref,amount\n')).toThrow(/header/);
  });

  it.each([
    ['too few fields', 'bank_A,pay_1,payment,100,success'],
    ['an unknown type', 'bank_A,pay_1,payout,100,success,2026-10-29'],
    ['an amount that is not whole paise', 'bank_A,pay_1,payment,1.5,success,2026-10-29'],
    ['a zero amount', 'bank_A,pay_1,payment,0,success,2026-10-29'],
    ['an unknown status', 'bank_A,pay_1,payment,100,maybe,2026-10-29'],
    ['a row from another day', 'bank_A,pay_1,payment,100,success,2026-10-28'],
    ['an empty reference', 'bank_A,,payment,100,success,2026-10-29'],
  ])('rejects a row with %s, naming its line', (_name, line) => {
    expect(() => parseSettlementCsv('2026-10-29', `${HEADER}\n${line}\n`)).toThrow(/line 2/);
  });
});
