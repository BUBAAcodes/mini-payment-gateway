import type { Logger } from 'pino';
import type { Prisma, PrismaClient, Settlement } from '@gateway/db';
import { ValidationError, isId, newId, type SettlementResponse } from '@gateway/shared';
import { recordEvent } from './events';
import { postPayout } from './ledger';
import { olderThan, toPage, type Page } from './pagination';

// Settlement (section 9.7): paying each merchant what we owe it. A settlement takes every capture
// and processed refund not yet settled, and stamps each row with its ID in the same transaction
// as the payout (decision 0002). A row that commits while a settlement is running is simply left
// for the next one, so nothing is paid twice or never.

const DAY_MS = 24 * 60 * 60_000;

export interface SettlementTotals {
  /** Captured amounts. */
  gross: number;
  /** Our fees on those captures. */
  fees: number;
  /** Processed refunds. Their fees aren't returned (decision 0001). */
  refunds: number;
  /** What we pay the merchant: gross − fees − refunds. Negative when it owes us. */
  net: number;
}

export function computeSettlement(
  payments: readonly { amount: number; fee: number }[],
  refunds: readonly { amount: number }[],
): SettlementTotals {
  const gross = sum(payments.map((p) => p.amount));
  const fees = sum(payments.map((p) => p.fee));
  const refunded = sum(refunds.map((r) => r.amount));
  return { gross, fees, refunds: refunded, net: gross - fees - refunded };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export interface SettleOptions {
  /** SETTLEMENT_DELAY_DAYS: only captures and refunds at least this old are settled. */
  delayDays: number;
  /** The job's clock. Tests pass their own. */
  now?: Date;
}

/**
 * Settles one merchant, in one transaction: the settlement row, its rows stamped, the ledger
 * payout and the settlement.processed event (rule 4). Returns null, writing nothing, when there is
 * nothing to settle or the net is zero or negative; those rows wait for a later settlement, which
 * recovers what the merchant owes from its new captures (section 9.7, step 4).
 */
export function settleMerchant(
  db: PrismaClient,
  merchantId: string,
  { delayDays, now = new Date() }: SettleOptions,
): Promise<Settlement | null> {
  const cutoff = new Date(now.getTime() - delayDays * DAY_MS);

  return db.$transaction(async (tx) => {
    // Runs for the same merchant take turns, so the second sees the first's stamps.
    await tx.$queryRaw`SELECT 1 FROM merchants WHERE id = ${merchantId} FOR UPDATE`;

    // FOR UPDATE: a refund can't change these rows while we pay them out.
    const payments = await tx.$queryRaw<{ id: string; amount: number; fee: number; at: Date }[]>`
      SELECT id, amount, fee, captured_at AS at FROM payments
       WHERE merchant_id = ${merchantId}
         AND status IN ('captured', 'refunded')
         AND settlement_id IS NULL
         AND captured_at < ${cutoff}
       ORDER BY captured_at, id
         FOR UPDATE`;
    const refunds = await tx.$queryRaw<{ id: string; amount: number; at: Date }[]>`
      SELECT id, amount, processed_at AS at FROM refunds
       WHERE merchant_id = ${merchantId}
         AND status = 'processed'
         AND settlement_id IS NULL
         AND processed_at < ${cutoff}
       ORDER BY processed_at, id
         FOR UPDATE`;

    const totals = computeSettlement(payments, refunds);
    if (totals.net <= 0) return null;

    const settlement = await tx.settlement.create({
      data: {
        id: newId('stl'),
        merchantId,
        periodStart: await periodStart(tx, merchantId, [...payments, ...refunds]),
        periodEnd: cutoff,
        ...totals,
      },
    });
    await tx.payment.updateMany({
      where: { id: { in: payments.map((p) => p.id) } },
      data: { settlementId: settlement.id },
    });
    await tx.refund.updateMany({
      where: { id: { in: refunds.map((r) => r.id) } },
      data: { settlementId: settlement.id },
    });
    await postPayout(tx, settlement);
    await recordEvent(tx, merchantId, 'settlement.processed', settlementResource(settlement));
    return settlement;
  });
}

/**
 * Where the last settlement ended, or the first row's time for a merchant's first settlement.
 * Earlier if a row from before then only committed after the last settlement ran.
 */
async function periodStart(
  tx: Prisma.TransactionClient,
  merchantId: string,
  rows: { at: Date }[],
): Promise<Date> {
  const earliest = Math.min(...rows.map((row) => row.at.getTime()));
  const previous = await tx.settlement.findFirst({
    where: { merchantId },
    orderBy: { periodEnd: 'desc' },
    select: { periodEnd: true },
  });
  return new Date(Math.min(earliest, previous?.periodEnd.getTime() ?? earliest));
}

export interface SettleAllResult {
  settled: Settlement[];
  /** Merchants whose settlement threw. Their rows stay unsettled for the next run. */
  failed: string[];
}

/**
 * The daily settlement run: each merchant in its own transaction. One merchant failing is logged
 * and doesn't stop the rest.
 */
export async function settleAllMerchants(
  db: PrismaClient,
  log: Logger,
  { delayDays, now = new Date() }: SettleOptions,
): Promise<SettleAllResult> {
  const merchants = await db.merchant.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  const result: SettleAllResult = { settled: [], failed: [] };

  for (const { id } of merchants) {
    try {
      const settlement = await settleMerchant(db, id, { delayDays, now });
      if (settlement) result.settled.push(settlement);
    } catch (err) {
      log.error({ err, merchant_id: id }, 'settlement failed');
      result.failed.push(id);
    }
  }

  log.info(
    { settled: result.settled.length, failed: result.failed.length },
    'settlement run finished',
  );
  return result;
}

/** Newest first. `startingAfter` is the last ID of the previous page. */
export async function listSettlements(
  db: PrismaClient,
  merchantId: string,
  { limit, startingAfter }: { limit: number; startingAfter?: string },
): Promise<Page<Settlement>> {
  let after: Prisma.SettlementWhereInput = {};
  if (startingAfter !== undefined) {
    const cursor = isId('stl', startingAfter)
      ? await db.settlement.findFirst({ where: { id: startingAfter, merchantId } })
      : null;
    if (!cursor) throw new ValidationError('No such settlement', 'starting_after');
    after = olderThan(cursor);
  }

  const rows = await db.settlement.findMany({
    where: { merchantId, ...after },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  return toPage(rows, limit);
}

/** The public JSON shape of a settlement. */
export function settlementResource(s: Settlement): SettlementResponse {
  return {
    id: s.id,
    period_start: s.periodStart.toISOString(),
    period_end: s.periodEnd.toISOString(),
    gross: s.gross,
    fees: s.fees,
    refunds: s.refunds,
    net: s.net,
    status: s.status,
    created_at: s.createdAt.toISOString(),
  };
}
