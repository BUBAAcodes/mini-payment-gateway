import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { Suspense } from 'react';
import { formatINR, type PaymentResponse, type RefundResponse } from '@gateway/shared';
import { CopyableId } from '@/components/dashboard/copy-button';
import { EventCard } from '@/components/dashboard/event-card';
import { EmptyState, LoadError, PageHeader } from '@/components/dashboard/page-header';
import { RefundForm } from '@/components/dashboard/refund-form';
import { DetailSkeleton } from '@/components/dashboard/skeletons';
import { StatusBadge } from '@/components/dashboard/status-badge';
import { getPayment, getPaymentActivity } from '@/lib/dashboard-api';
import { formatDateTime, methodSummary, statusLabel, statusTone } from '@/lib/dashboard-format';
import { requireMerchant } from '@/lib/session';
import { refundPayment } from './actions';

export default function PaymentPage({ params }: PageProps<'/dashboard/payments/[id]'>) {
  return (
    <section>
      <Link
        href="/dashboard/payments"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← All payments
      </Link>
      <Suspense fallback={<DetailSkeleton />}>
        <Payment params={params} />
      </Suspense>
    </section>
  );
}

async function Payment({ params }: Pick<PageProps<'/dashboard/payments/[id]'>, 'params'>) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  // Another merchant's payment is "not found", exactly like one that doesn't exist.
  const [result, activity] = await Promise.all([
    getPayment(merchantId, id),
    getPaymentActivity(merchantId, id),
  ]);
  if (!result.ok) return <LoadError message={result.error.message} />;

  const payment = result.data;
  const remaining = payment.amount - payment.amount_refunded;

  return (
    <div className="mt-4">
      <PageHeader eyebrow="Payment" title={formatINR(payment.amount)} />
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <StatusBadge tone={statusTone(payment.status)}>{statusLabel(payment.status)}</StatusBadge>
        <CopyableId id={payment.id} label="payment ID" />
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 rounded-card bg-card p-6 text-sm sm:grid-cols-[10rem_1fr] sm:gap-y-3">
          <Row label="Order">
            <CopyableId id={payment.order_id} label="order ID" />
          </Row>
          <Row label="Method">{methodSummary(payment)}</Row>
          <Row label="Fee">{payment.fee === null ? '—' : formatINR(payment.fee)}</Row>
          <Row label="Refunded">{formatINR(payment.amount_refunded)}</Row>
          <Row label="Created">{formatDateTime(payment.created_at)}</Row>
          <Row label="Authorized">{formatDateTime(payment.authorized_at)}</Row>
          <Row label="Captured">{formatDateTime(payment.captured_at)}</Row>
          {payment.failure_reason && <Row label="Failure reason">{payment.failure_reason}</Row>}
        </dl>

        <aside className="rounded-card border border-border p-6">
          <h2 className="font-display mb-1 text-lg uppercase">Refund</h2>
          <RefundPanel payment={payment} remaining={remaining} />
        </aside>
      </div>

      {!activity.ok ? (
        <div className="mt-12">
          <LoadError message={activity.error.message} />
        </div>
      ) : (
        <>
          <h2 className="font-display mt-12 mb-4 text-xl uppercase">Refunds</h2>
          {activity.data.refunds.length === 0 ? (
            <EmptyState>No refunds on this payment.</EmptyState>
          ) : (
            <ul className="divide-y divide-border border-y border-border">
              {activity.data.refunds.map((refund) => (
                <RefundRow key={refund.id} refund={refund} />
              ))}
            </ul>
          )}

          <h2 className="font-display mt-12 mb-4 text-xl uppercase">Webhook events</h2>
          {activity.data.events.length === 0 ? (
            <EmptyState>No events about this payment yet.</EmptyState>
          ) : (
            <ul className="space-y-4">
              {activity.data.events.map((event) => (
                <EventCard key={event.id} event={event} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function RefundRow({ refund }: { refund: RefundResponse }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
      <div className="flex items-center gap-3">
        <span className="font-semibold tabular-nums">{formatINR(refund.amount)}</span>
        <StatusBadge tone={statusTone(refund.status)}>{statusLabel(refund.status)}</StatusBadge>
        {refund.failure_reason && (
          <span className="text-muted-foreground">{refund.failure_reason}</span>
        )}
      </div>
      <div className="flex items-center gap-3 text-muted-foreground">
        <CopyableId id={refund.id} label="refund ID" />
        <span>{formatDateTime(refund.created_at)}</span>
      </div>
    </li>
  );
}

function RefundPanel({ payment, remaining }: { payment: PaymentResponse; remaining: number }) {
  if (payment.status !== 'captured' || remaining <= 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {payment.status === 'refunded'
          ? 'This payment has been refunded in full.'
          : 'Only captured payments can be refunded.'}
      </p>
    );
  }
  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">
        {formatINR(remaining)} left to refund. Our fee is not returned.
      </p>
      <RefundForm
        action={refundPayment.bind(null, payment.id)}
        // A new key each time the page renders: submitting this form twice refunds once.
        idempotencyKey={randomUUID()}
        remaining={formatINR(remaining)}
      />
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mb-2 min-w-0 break-words sm:mb-0">{children}</dd>
    </>
  );
}
