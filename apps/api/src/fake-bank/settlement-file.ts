import type { BankTransaction } from '@gateway/db';

// The bank's daily settlement file, which step 17's reconciliation imports. Bank days run
// midnight to midnight India time (UTC+05:30, no daylight saving).

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const BANK_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const SETTLEMENT_CSV_HEADER = 'bank_ref,gateway_reference,type,amount,status,bank_date';

export type SettlementRow = Pick<
  BankTransaction,
  'bankRef' | 'gatewayReference' | 'type' | 'amount' | 'outcome'
>;

/** The instants a bank day covers: [start, end). */
export function istDayBounds(bankDate: string): { start: Date; end: Date } {
  const utcMidnight = Date.parse(`${bankDate}T00:00:00Z`);
  // Date.parse rolls 2026-02-30 over to March, so check the date survives the round trip.
  if (
    !BANK_DATE.test(bankDate) ||
    Number.isNaN(utcMidnight) ||
    new Date(utcMidnight).toISOString().slice(0, 10) !== bankDate
  ) {
    throw new RangeError(`Bank dates look like 2026-10-29, got ${JSON.stringify(bankDate)}`);
  }
  const start = new Date(utcMidnight - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** The bank day an instant falls on. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Every field is an ID, an integer or a fixed word, so no CSV quoting is needed. */
export function toSettlementCsv(bankDate: string, rows: SettlementRow[]): string {
  const lines = rows.map((row) =>
    [
      row.bankRef,
      row.gatewayReference,
      row.type,
      row.amount,
      row.outcome === 'approved' ? 'success' : 'failed',
      bankDate,
    ].join(','),
  );
  return [SETTLEMENT_CSV_HEADER, ...lines].join('\n') + '\n';
}
