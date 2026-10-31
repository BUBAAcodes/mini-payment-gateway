import { randomUUID } from 'node:crypto';
import { Suspense } from 'react';
import { WEBHOOK_EVENT_TYPES } from '@gateway/shared';
import { ActionButton } from '@/components/dashboard/action-button';
import { LoadingText } from '@/components/dashboard/loading-text';
import { EmptyState, LoadError, PageHeader } from '@/components/dashboard/page-header';
import { StatusBadge } from '@/components/dashboard/status-badge';
import { WebhookForm } from '@/components/dashboard/webhook-form';
import { listWebhookEndpoints } from '@/lib/dashboard-api';
import { formatDateTime } from '@/lib/dashboard-format';
import { requireMerchant } from '@/lib/session';
import { createEndpoint, deleteEndpoint, sendTestEvent } from './actions';

export default function WebhooksPage() {
  return (
    <section className="space-y-10">
      <PageHeader eyebrow="Developers" title="Webhooks">
        We POST signed events (Standard Webhooks) to these URLs and retry for about a day if they
        fail. Check the signature with the endpoint&apos;s secret, shown once when you add it.
      </PageHeader>
      <Suspense fallback={<LoadingText />}>
        <Endpoints />
      </Suspense>
    </section>
  );
}

async function Endpoints() {
  const { merchantId } = await requireMerchant();
  const endpoints = await listWebhookEndpoints(merchantId);

  return (
    <>
      <div className="rounded-card bg-card p-6">
        <h2 className="font-display mb-4 text-lg uppercase">Add an endpoint</h2>
        <WebhookForm
          action={createEndpoint}
          idempotencyKey={randomUUID()}
          eventTypes={WEBHOOK_EVENT_TYPES}
        />
      </div>

      {!endpoints.ok ? (
        <LoadError message={endpoints.error.message} />
      ) : endpoints.data.data.length === 0 ? (
        <EmptyState>No endpoints yet.</EmptyState>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {endpoints.data.data.map((endpoint) => (
            <li key={endpoint.id} className="flex flex-wrap items-start justify-between gap-4 py-5">
              <div className="min-w-0 space-y-2">
                <p className="font-mono text-sm break-all">{endpoint.url}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {endpoint.enabled ? (
                    <StatusBadge tone="success">Enabled</StatusBadge>
                  ) : (
                    <StatusBadge tone="danger">Disabled: {endpoint.disabled_reason}</StatusBadge>
                  )}
                  {endpoint.event_types.map((type) => (
                    <span
                      key={type}
                      className="rounded-xs border border-border px-1.5 font-mono text-xs"
                    >
                      {type === '*' ? 'all events' : type}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {endpoint.id} · added {formatDateTime(endpoint.created_at)}
                </p>
              </div>
              <div className="flex gap-3">
                <ActionButton
                  action={sendTestEvent.bind(null, endpoint.id)}
                  label="Send test"
                  pendingLabel="Sending…"
                />
                <ActionButton
                  action={deleteEndpoint.bind(null, endpoint.id)}
                  label="Delete"
                  pendingLabel="Deleting…"
                  confirm={{
                    title: 'Delete this endpoint?',
                    description: `We will stop sending events to ${endpoint.url}. Deliveries already queued are not sent.`,
                    confirmLabel: 'Delete endpoint',
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
