import { Suspense } from 'react';
import { ActionButton } from '@/components/dashboard/action-button';
import { CreateKeyForm } from '@/components/dashboard/create-key-form';
import { TableSkeleton } from '@/components/dashboard/skeletons';
import { EmptyState, LoadError, PageHeader } from '@/components/dashboard/page-header';
import { StatusBadge } from '@/components/dashboard/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listApiKeys } from '@/lib/dashboard-api';
import { formatDateTime } from '@/lib/dashboard-format';
import { requireMerchant } from '@/lib/session';
import { createKey, revokeKey } from './actions';

export default function ApiKeysPage() {
  return (
    <section className="space-y-10">
      <PageHeader eyebrow="Developers" title="API keys">
        Your server sends one of these as{' '}
        <code className="font-mono">Authorization: Bearer sk_test_…</code>. We keep only a hash, so
        a new key is shown once.
      </PageHeader>
      <CreateKeyForm action={createKey} />
      <Suspense fallback={<TableSkeleton rows={3} />}>
        <Keys />
      </Suspense>
    </section>
  );
}

async function Keys() {
  const { merchantId } = await requireMerchant();
  const keys = await listApiKeys(merchantId);
  if (!keys.ok) return <LoadError message={keys.error.message} />;
  if (keys.data.data.length === 0) return <EmptyState>No API keys yet.</EmptyState>;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Key</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.data.data.map((key) => (
          <TableRow key={key.id}>
            <TableCell className="font-mono text-xs">{key.prefix}…</TableCell>
            <TableCell>
              {key.revoked_at ? (
                <StatusBadge tone="neutral">Revoked {formatDateTime(key.revoked_at)}</StatusBadge>
              ) : (
                <StatusBadge tone="success">Active</StatusBadge>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatDateTime(key.last_used_at)}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatDateTime(key.created_at)}
            </TableCell>
            <TableCell className="text-right">
              {!key.revoked_at && (
                <ActionButton
                  action={revokeKey.bind(null, key.id)}
                  label="Revoke"
                  pendingLabel="Revoking…"
                  confirm={{
                    title: `Revoke ${key.prefix}…?`,
                    description:
                      'Requests with this key will get 401 straight away. This cannot be undone.',
                    confirmLabel: 'Revoke key',
                  }}
                />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
