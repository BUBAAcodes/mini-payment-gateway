import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { Suspense } from 'react';
import { formatINR, type PaymentResponse } from '@gateway/shared';
import { LoadingText } from '@/components/dashboard/loading-text';
import { LoadError, PageHeader } from '@/components/dashboard/page-header';
import { RefundForm } from '@/components/dashboard/refund-form';
import { StatusBadge } from '@/components/dashboard/status-badge';
import { getPayment } from '@/lib/dashboard-api';
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
      <Suspense fallback={<LoadingText />}>
        <Payment params={params} />
      </Suspense>
    </section>
  );
}

async function Payment({ params }: Pick<PageProps<'/dashboard/payments/[id]'>, 'params'>) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  // Another merchant's payment is "not found", exactly like one that doesn't exist.
  const result = await getPayment(merchantId, id);
  if (!result.ok) return <LoadError message={result.error.message} />;

  const payment = result.data;
  const remaining = payment.amount - payment.amount_refunded;

  return (
    <div className="mt-4">
      <PageHeader eyebrow="Payment" title={formatINR(payment.amount)} />
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <StatusBadge tone={statusTone(payment.status)}>{statusLabel(payment.status)}</StatusBadge>
        <code className="font-mono text-sm text-muted-foreground">{payment.id}</code>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <dl className="grid grid-cols-[10rem_1fr] gap-x-6 gap-y-3 rounded-card bg-card p-6 text-sm">
          <Row label="Order">
            <code className="font-mono">{payment.order_id}</code>
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
    </div>
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
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
