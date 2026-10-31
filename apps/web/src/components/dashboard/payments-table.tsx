import Link from 'next/link';
import { formatINR, type PaymentResponse } from '@gateway/shared';
import { CopyButton } from '@/components/dashboard/copy-button';
import { StatusBadge } from '@/components/dashboard/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime, methodSummary, statusLabel, statusTone } from '@/lib/dashboard-format';

/** Payments as a table on wide screens and as stacked cards on phones. */
export function PaymentsTable({ payments }: { payments: PaymentResponse[] }) {
  return (
    <>
      <ul className="space-y-3 md:hidden">
        {payments.map((payment) => (
          <li key={payment.id}>
            <Link
              href={`/dashboard/payments/${payment.id}`}
              className="block rounded-card border border-border p-4 transition-colors hover:bg-accent"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-lg font-semibold tabular-nums">{formatINR(payment.amount)}</p>
                  {payment.amount_refunded > 0 && (
                    <p className="text-xs text-muted-foreground">
                      −{formatINR(payment.amount_refunded)} refunded
                    </p>
                  )}
                </div>
                <StatusBadge tone={statusTone(payment.status)}>
                  {statusLabel(payment.status)}
                </StatusBadge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{methodSummary(payment)}</p>
              <p className="mt-1 flex justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate font-mono">{payment.id}</span>
                <span className="shrink-0">{formatDateTime(payment.created_at)}</span>
              </p>
            </Link>
          </li>
        ))}
      </ul>

      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Payment</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.map((payment) => (
              <TableRow key={payment.id}>
                <TableCell>
                  <span className="inline-flex items-center gap-1">
                    <Link
                      href={`/dashboard/payments/${payment.id}`}
                      className="font-mono text-xs underline-offset-4 hover:underline"
                    >
                      {payment.id}
                    </Link>
                    <CopyButton value={payment.id} label="payment ID" />
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatINR(payment.amount)}
                  {payment.amount_refunded > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      −{formatINR(payment.amount_refunded)} refunded
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge tone={statusTone(payment.status)}>
                    {statusLabel(payment.status)}
                  </StatusBadge>
                </TableCell>
                <TableCell className="text-muted-foreground">{methodSummary(payment)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(payment.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
