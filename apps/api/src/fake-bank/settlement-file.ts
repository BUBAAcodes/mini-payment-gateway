import type { BankTransaction } from '@gateway/db';

// The bank's daily settlement file: the fake bank writes it and reconciliation reads it. Bank days
// run midnight to midnight India time (UTC+05:30, no daylight saving).

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

/** One line of a bank's settlement file, as the gateway reads it. */
export interface BankFileRow {
  bankRef: string;
  gatewayReference: string;
  type: 'payment' | 'refund';
  amount: number;
  status: 'success' | 'failed';
}

const TYPES: readonly string[] = ['payment', 'refund'];
const STATUSES: readonly string[] = ['success', 'failed'];
const WHOLE_PAISE = /^[1-9]\d*$/;

/**
 * Reads a settlement file for `bankDate`. Throws on anything unexpected, naming the line, so a
 * bad file stops reconciliation instead of turning into a pile of false issues.
 */
export function parseSettlementCsv(bankDate: string, csv: string): BankFileRow[] {
  const [header, ...lines] = csv.split(/\r?\n/);
  if (header !== SETTLEMENT_CSV_HEADER) {
    throw new Error(`Settlement file header should be "${SETTLEMENT_CSV_HEADER}"`);
  }

  const rows: BankFileRow[] = [];
  lines.forEach((line, index) => {
    if (line === '') return;
    const problem = (what: string) =>
      new Error(`Settlement file line ${index + 2}: ${what}: ${JSON.stringify(line)}`);

    const fields = line.split(',');
    if (fields.length !== 6) throw problem('expected 6 fields');
    const [bankRef, gatewayReference, type, amount, status, date] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (bankRef === '' || gatewayReference === '') throw problem('empty reference');
    if (!TYPES.includes(type)) throw problem('unknown type');
    if (!WHOLE_PAISE.test(amount) || !Number.isSafeInteger(Number(amount))) {
      throw problem('amount must be a positive whole number of paise');
    }
    if (!STATUSES.includes(status)) throw problem('unknown status');
    if (date !== bankDate) throw problem(`not from ${bankDate}`);

    rows.push({
      bankRef,
      gatewayReference,
      type: type as BankFileRow['type'],
      amount: Number(amount),
      status: status as BankFileRow['status'],
    });
  });
  return rows;
}
