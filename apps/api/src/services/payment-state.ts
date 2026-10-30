import { Prisma, type Payment, type PaymentStatus } from '@gateway/db';
import { InvalidStateError } from '@gateway/shared';

/** Every move a payment may make (spec section 9.2). Anything not listed throws. */
export const ALLOWED_MOVES: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  created: ['otp_required', 'pending'],
  otp_required: ['pending'],
  pending: ['authorized', 'failed'],
  authorized: ['captured'],
  captured: ['refunded'],
  failed: [],
  refunded: [],
};

/** Checks a move against the table. Returns the new status, or throws invalid_state. */
export function transition(
  payment: Pick<Payment, 'id' | 'status'>,
  to: PaymentStatus,
): PaymentStatus {
  if (!ALLOWED_MOVES[payment.status].includes(to)) {
    throw new InvalidStateError(
      `Payment ${payment.id} cannot move from ${payment.status} to ${to}`,
    );
  }
  return to;
}

/**
 * Moves a payment to a new status and saves it, along with any columns that change with it.
 * The update matches only while the row still has the status we read, so if another request moved
 * the payment first, this throws instead of overwriting that move.
 */
export async function moveTo(
  db: Prisma.TransactionClient,
  payment: Payment,
  to: PaymentStatus,
  data: Omit<Prisma.PaymentUpdateInput, 'status'> = {},
): Promise<Payment> {
  const status = transition(payment, to);
  try {
    return await db.payment.update({
      where: { id: payment.id, status: payment.status },
      data: { ...data, status },
    });
  } catch (err) {
    // P2025: no row matched, because the status changed after we read it.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw new InvalidStateError(`Payment ${payment.id} is no longer ${payment.status}`);
    }
    throw err;
  }
}
