import type {
  Prisma,
  PrismaClient,
  ReconciliationIssue,
  ReconciliationIssueKind,
} from '@gateway/db';
import {
  NotFoundError,
  ValidationError,
  type ListReconciliationIssuesInput,
  type ReconciliationIssueResponse,
} from '@gateway/shared';
import type { BankClient } from '../fake-bank';
import {
  istDate,
  istDayBounds,
  parseSettlementCsv,
  type BankFileRow,
} from '../fake-bank/settlement-file';
import { olderThan, toPage, type Page } from './pagination';

// Reconciliation (section 9.8): checking our records against the bank's. The bank's daily file is
// a second, independent account of what happened; wherever the two disagree we record an issue
// for a person to look at. Nothing here changes a payment or refund.

const DAY_MS = 24 * 60 * 60_000;

/** How many days a run without bank_date goes back for days the cron missed. */
export const MAX_CATCH_UP_DAYS = 7;

/** One of our payments or refunds, as reconciliation sees it. */
export interface GatewayRecord {
  id: string;
  merchantId: string;
  type: 'payment' | 'refund';
  amount: number;
  status: string;
}

export interface IssueInput {
  kind: ReconciliationIssueKind;
  /** Null when the bank has a row we can't match to any merchant. */
  merchantId: string | null;
  gatewayReference: string;
  bankRef: string | null;
  details: Record<string, string | number>;
}

/** Our statuses that agree with each bank status. A refunded payment was still a success. */
const AGREEING_STATUSES: Record<BankFileRow['type'], Record<BankFileRow['status'], string[]>> = {
  payment: { success: ['captured', 'refunded'], failed: ['failed'] },
  refund: { success: ['processed'], failed: ['failed'] },
};

const keyOf = (type: string, id: string) => `${type}:${id}`;

export interface CompareInput {
  /** The day's bank file. */
  bankRows: readonly BankFileRow[];
  /** Our records for the references in the file (and any others; extras are ignored). */
  ours: readonly GatewayRecord[];
  /** Ours that the bank should have paid that day: captures and processed refunds. */
  expected: readonly GatewayRecord[];
  /**
   * "type:id" of expected records found on other days' files. A payment the bank approved just
   * before midnight and we captured just after is on the previous day's file, which is fine.
   */
  onOtherFiles: ReadonlySet<string>;
}

/** Every disagreement between the bank's file and our records. */
export function compareRecords({
  bankRows,
  ours,
  expected,
  onOtherFiles,
}: CompareInput): IssueInput[] {
  const ourRecords = new Map(ours.map((record) => [keyOf(record.type, record.id), record]));
  const issues: IssueInput[] = [];

  for (const row of bankRows) {
    const base = { gatewayReference: row.gatewayReference, bankRef: row.bankRef };
    const record = ourRecords.get(keyOf(row.type, row.gatewayReference));
    if (!record) {
      issues.push({
        ...base,
        kind: 'missing_in_gateway',
        merchantId: null,
        details: { type: row.type, amount: row.amount, bank_status: row.status },
      });
      continue;
    }

    const found = { ...base, merchantId: record.merchantId };
    if (record.amount !== row.amount) {
      issues.push({
        ...found,
        kind: 'amount_mismatch',
        details: { type: row.type, bank_amount: row.amount, gateway_amount: record.amount },
      });
    }
    // lost@test ends up here: the bank approved it, but we never heard and failed it.
    if (!AGREEING_STATUSES[row.type][row.status].includes(record.status)) {
      issues.push({
        ...found,
        kind: 'status_mismatch',
        details: { type: row.type, bank_status: row.status, gateway_status: record.status },
      });
    }
  }

  const onThisFile = new Set(bankRows.map((row) => keyOf(row.type, row.gatewayReference)));
  for (const record of expected) {
    const key = keyOf(record.type, record.id);
    if (onThisFile.has(key) || onOtherFiles.has(key)) continue;
    issues.push({
      kind: 'missing_in_bank',
      merchantId: record.merchantId,
      gatewayReference: record.id,
      bankRef: null,
      details: { type: record.type, amount: record.amount, gateway_status: record.status },
    });
  }

  return issues;
}

export interface ReconcileDeps {
  db: PrismaClient;
  bank: BankClient;
}

export interface DayResult {
  bankDate: string;
  /** Rows in the bank's file. */
  rows: number;
  /** New issues. Ones already recorded for that day aren't counted again. */
  issuesCreated: number;
}

/**
 * Imports one day's bank file and records every disagreement with our records. Safe to run again
 * for the same day: the file and its rows are replaced, and issues already recorded are skipped,
 * so a re-run only adds what is new (such as rows the bank decided since).
 */
export async function reconcileDay(deps: ReconcileDeps, bankDate: string): Promise<DayResult> {
  const { start, end } = istDayBounds(bankDate);
  const day = new Date(`${bankDate}T00:00:00Z`);
  // Fetched before the transaction: never hold one open while calling the bank (rule 11).
  const csv = await deps.bank.settlementFile(bankDate);
  const bankRows = parseSettlementCsv(bankDate, csv);

  return deps.db.$transaction(async (tx) => {
    // The unique bank_date makes concurrent runs for one day take turns here.
    const file = await tx.bankSettlementFile.upsert({
      where: { bankDate: day },
      create: { bankDate: day, csvText: csv },
      update: { csvText: csv, importedAt: new Date() },
    });
    await tx.bankSettlementRow.deleteMany({ where: { fileId: file.id } });
    await tx.bankSettlementRow.createMany({
      data: bankRows.map((row) => ({ fileId: file.id, ...row })),
    });

    const referenced = (type: BankFileRow['type']) =>
      bankRows.filter((row) => row.type === type).map((row) => row.gatewayReference);
    const payments = await tx.payment.findMany({ where: { id: { in: referenced('payment') } } });
    const refunds = await tx.refund.findMany({ where: { id: { in: referenced('refund') } } });
    const capturedThatDay = await tx.payment.findMany({
      where: { status: { in: ['captured', 'refunded'] }, capturedAt: { gte: start, lt: end } },
    });
    const refundedThatDay = await tx.refund.findMany({
      where: { status: 'processed', processedAt: { gte: start, lt: end } },
    });
    const asPayment = (p: (typeof payments)[number]): GatewayRecord => ({
      id: p.id,
      merchantId: p.merchantId,
      type: 'payment',
      amount: p.amount,
      status: p.status,
    });
    const asRefund = (r: (typeof refunds)[number]): GatewayRecord => ({
      id: r.id,
      merchantId: r.merchantId,
      type: 'refund',
      amount: r.amount,
      status: r.status,
    });
    const expected = [...capturedThatDay.map(asPayment), ...refundedThatDay.map(asRefund)];

    const elsewhere = await tx.bankSettlementRow.findMany({
      where: { gatewayReference: { in: expected.map((r) => r.id) }, fileId: { not: file.id } },
      select: { gatewayReference: true, type: true },
    });

    const issues = compareRecords({
      bankRows,
      ours: [...payments.map(asPayment), ...refunds.map(asRefund)],
      expected,
      onOtherFiles: new Set(elsewhere.map((row) => keyOf(row.type, row.gatewayReference))),
    });
    const { count } = await tx.reconciliationIssue.createMany({
      data: issues.map((issue) => ({ ...issue, bankDate: day })),
      skipDuplicates: true,
    });
    return { bankDate, rows: bankRows.length, issuesCreated: count };
  });
}

export interface ReconcileOptions {
  /** Just this day (YYYY-MM-DD, India time). Without it, catches up through yesterday. */
  bankDate?: string;
  /** The job's clock. Tests pass their own. */
  now?: Date;
}

/**
 * The daily reconciliation run. The cron calls it at 02:00 IST, when yesterday's file is complete.
 * Without a bank date, it reconciles every day from the last one imported through yesterday,
 * at most MAX_CATCH_UP_DAYS, so days the cron missed are caught up (rule 12). The last day
 * imported is run again, in case it was imported before the day was over.
 */
export async function reconcile(
  deps: ReconcileDeps,
  { bankDate, now = new Date() }: ReconcileOptions = {},
): Promise<DayResult[]> {
  const today = istDate(now);
  if (bankDate !== undefined) {
    if (bankDate > today) {
      throw new ValidationError(`bank_date can't be after today (${today})`, 'bank_date');
    }
    return [await reconcileDay(deps, bankDate)];
  }

  const yesterday = addDays(today, -1);
  const latest = await deps.db.bankSettlementFile.findFirst({
    orderBy: { bankDate: 'desc' },
    select: { bankDate: true },
  });
  const latestDate = latest ? latest.bankDate.toISOString().slice(0, 10) : yesterday;
  const earliest = addDays(yesterday, -(MAX_CATCH_UP_DAYS - 1));
  let day = latestDate < yesterday ? latestDate : yesterday;
  if (day < earliest) day = earliest;

  // One day at a time, oldest first. A failure stops the run; the next run starts from there.
  const results: DayResult[] = [];
  for (; day <= yesterday; day = addDays(day, 1)) {
    results.push(await reconcileDay(deps, day));
  }
  return results;
}

/** YYYY-MM-DD plus some days. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// ---------- Issues, for the dashboard ----------

// Issue IDs are Postgres UUIDs. Checking the shape first turns a malformed ID into a plain 404
// instead of a database error.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The merchant's issues, newest first, optionally only open or only resolved. Issues with no
 * merchant (a bank row we can't match to anyone) are ours to look at, so no merchant sees them.
 */
export async function listReconciliationIssues(
  db: PrismaClient,
  merchantId: string,
  { limit, starting_after: startingAfter, status }: ListReconciliationIssuesInput,
): Promise<Page<ReconciliationIssue>> {
  let after: Prisma.ReconciliationIssueWhereInput = {};
  if (startingAfter !== undefined) {
    const cursor = UUID.test(startingAfter)
      ? await db.reconciliationIssue.findFirst({ where: { id: startingAfter, merchantId } })
      : null;
    if (!cursor) throw new ValidationError('No such reconciliation issue', 'starting_after');
    after = olderThan(cursor);
  }

  const resolved =
    status === 'open'
      ? { resolvedAt: null }
      : status === 'resolved'
        ? { NOT: { resolvedAt: null } }
        : {};
  const rows = await db.reconciliationIssue.findMany({
    where: { merchantId, ...resolved, ...after },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  return toPage(rows, limit);
}

/** Marks an issue resolved. Resolving twice keeps the first resolved_at. */
export async function resolveReconciliationIssue(
  db: PrismaClient,
  merchantId: string,
  issueId: string,
): Promise<ReconciliationIssue> {
  if (!UUID.test(issueId)) throw new NotFoundError('Reconciliation issue');
  await db.reconciliationIssue.updateMany({
    where: { id: issueId, merchantId, resolvedAt: null },
    data: { resolvedAt: new Date() },
  });
  const issue = await db.reconciliationIssue.findFirst({ where: { id: issueId, merchantId } });
  if (!issue) throw new NotFoundError('Reconciliation issue');
  return issue;
}

export function reconciliationIssueResource(i: ReconciliationIssue): ReconciliationIssueResponse {
  return {
    id: i.id,
    bank_date: i.bankDate.toISOString().slice(0, 10),
    kind: i.kind,
    gateway_reference: i.gatewayReference,
    bank_ref: i.bankRef,
    details: i.details as Record<string, unknown>,
    resolved_at: i.resolvedAt?.toISOString() ?? null,
    created_at: i.createdAt.toISOString(),
  };
}
