import type {
  LedgerDirection,
  LedgerTransaction,
  LedgerTransactionType,
  Payment,
  Prisma,
  Refund,
} from '@gateway/db';
import { newId } from '@gateway/shared';

// The double-entry ledger (section 9.4): every money movement is one ledger transaction whose
// entries balance, total debits = total credits. Rows are only ever added (rule 3). The database
// rejects updates, deletes and, at COMMIT, any unbalanced transaction; this service refuses bad
// entries earlier, before anything is written, with an error that says what was wrong.

export interface LedgerEntryInput {
  /** Account code: gateway_clearing, fee_revenue, payouts or merchant_balance:{merchantId}. */
  account: string;
  direction: LedgerDirection;
  /** Paise, always positive: the direction carries the sign. */
  amount: number;
}

export interface LedgerTransactionInput {
  type: LedgerTransactionType;
  /** What the transaction records, e.g. "payment" and its pay_ ID. */
  referenceType: string;
  referenceId: string;
}

/** The account holding what we owe one merchant. Created with the merchant. */
export function merchantBalanceAccount(merchantId: string): string {
  return `merchant_balance:${merchantId}`;
}

/** Throws unless the entries make a valid double-entry transaction. */
export function checkBalanced(entries: readonly LedgerEntryInput[]): void {
  if (entries.length === 0) throw new Error('A ledger transaction needs at least one entry');

  let debits = 0;
  let credits = 0;
  for (const { account, direction, amount } of entries) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(
        `Ledger entry for ${account} must be a positive whole number of paise, got ${amount}`,
      );
    }
    if (direction === 'debit') debits += amount;
    else credits += amount;
  }
  if (debits !== credits) {
    throw new Error(`Ledger entries do not balance: debits ${debits}, credits ${credits}`);
  }
}

/**
 * Posts one ledger transaction with its entries. Call it inside the database transaction that
 * makes the change it records, so both commit or neither does (rule 4). Unbalanced entries or an
 * unknown account throw before anything is inserted.
 */
export async function postLedgerTransaction(
  tx: Prisma.TransactionClient,
  transaction: LedgerTransactionInput,
  entries: readonly LedgerEntryInput[],
): Promise<LedgerTransaction> {
  checkBalanced(entries);
  const accountIds = await findAccountIds(
    tx,
    entries.map((e) => e.account),
  );
  return tx.ledgerTransaction.create({
    data: {
      id: newId('ltx'),
      type: transaction.type,
      referenceType: transaction.referenceType,
      referenceId: transaction.referenceId,
      entries: {
        create: entries.map(({ account, direction, amount }) => ({
          accountId: accountIds.get(account)!,
          direction,
          amount,
        })),
      },
    },
  });
}

/** Account IDs by code, in one query. Throws if any code has no account. */
async function findAccountIds(
  tx: Prisma.TransactionClient,
  codes: string[],
): Promise<Map<string, string>> {
  const accounts = await tx.ledgerAccount.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true },
  });
  const ids = new Map(accounts.map((a) => [a.code, a.id]));
  const missing = [...new Set(codes.filter((code) => !ids.has(code)))];
  if (missing.length > 0) {
    throw new Error(`Ledger account does not exist: ${missing.join(', ')}`);
  }
  return ids;
}

/**
 * A capture's entries (section 9.4). We hold the whole amount in clearing, owe the merchant the
 * amount minus our fee, and keep the fee.
 */
export function postCapture(
  tx: Prisma.TransactionClient,
  payment: Payment,
): Promise<LedgerTransaction> {
  if (payment.status !== 'captured' || payment.fee === null) {
    throw new Error(`Payment ${payment.id} must be captured, with its fee, before it is posted`);
  }
  const entries: LedgerEntryInput[] = [
    { account: 'gateway_clearing', direction: 'debit', amount: payment.amount },
    {
      account: merchantBalanceAccount(payment.merchantId),
      direction: 'credit',
      amount: payment.amount - payment.fee,
    },
  ];
  // Entry amounts must be positive, so a zero fee (FEE_BPS=0) gets no entry.
  if (payment.fee > 0) {
    entries.push({ account: 'fee_revenue', direction: 'credit', amount: payment.fee });
  }
  return postLedgerTransaction(
    tx,
    { type: 'capture', referenceType: 'payment', referenceId: payment.id },
    entries,
  );
}

/**
 * A processed refund's entries (section 9.4). The merchant gives back the whole refunded amount
 * and the money leaves clearing for the customer. Our fee is not returned (decision 0001), so a
 * full refund leaves the merchant owing us the fee: its balance can go negative.
 */
export function postRefund(
  tx: Prisma.TransactionClient,
  refund: Refund,
): Promise<LedgerTransaction> {
  if (refund.status !== 'processed') {
    throw new Error(`Refund ${refund.id} must be processed before it is posted`);
  }
  return postLedgerTransaction(
    tx,
    { type: 'refund', referenceType: 'refund', referenceId: refund.id },
    [
      {
        account: merchantBalanceAccount(refund.merchantId),
        direction: 'debit',
        amount: refund.amount,
      },
      { account: 'gateway_clearing', direction: 'credit', amount: refund.amount },
    ],
  );
}

/**
 * What we owe a merchant right now: credits minus debits on its merchant_balance account. It can
 * go negative after refunds (section 9.5). Summed as bigint, since a busy merchant's total can
 * pass the 32-bit range of the amount column.
 */
export async function getMerchantBalance(
  db: Prisma.TransactionClient,
  merchantId: string,
): Promise<number> {
  const [row] = await db.$queryRaw<{ balance: bigint }[]>`
    SELECT COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END), 0)::bigint
           AS balance
      FROM ledger_entries e
      JOIN ledger_accounts a ON a.id = e.account_id
     WHERE a.code = ${merchantBalanceAccount(merchantId)}`;
  return Number(row?.balance ?? 0);
}
