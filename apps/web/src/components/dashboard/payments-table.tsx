import Link from 'next/link';
import type { PaymentResponse } from '@gateway/shared';
import { formatINR } from '@gateway/shared';
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

export function PaymentsTable({ payments }: { payments: PaymentResponse[] }) {
  return (
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
              <Link
                href={`/dashboard/payments/${payment.id}`}
                className="font-mono text-xs underline-offset-4 hover:underline"
              >
                {payment.id}
              </Link>
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
  );
}
