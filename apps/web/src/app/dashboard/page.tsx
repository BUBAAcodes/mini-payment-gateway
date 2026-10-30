import { Suspense } from 'react';
import { formatINR } from '@gateway/shared';
import { Eyebrow } from '@/components/checkout/ui';
import { getBalance, getMerchant } from '@/lib/dashboard-api';
import { requireMerchant } from '@/lib/session';

/** Overview. Step 20 adds volume, success rate and the other pages. */
export default function DashboardPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
      <Overview />
    </Suspense>
  );
}

async function Overview() {
  // The merchant ID comes from the session, and only from there.
  const { merchantId } = await requireMerchant();
  const [merchant, balance] = await Promise.all([getMerchant(merchantId), getBalance(merchantId)]);

  if (!merchant.ok || !balance.ok) {
    const error = merchant.ok ? (balance.ok ? null : balance.error) : merchant.error;
    return (
      <p role="alert" className="text-destructive">
        {error?.message}
      </p>
    );
  }

  return (
    <section className="space-y-8">
      <div>
        <Eyebrow>Merchant</Eyebrow>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{merchant.data.name}</h1>
      </div>
      <div className="rounded-card bg-card p-6">
        <Eyebrow>Unsettled balance</Eyebrow>
        <p
          className={
            balance.data.balance < 0
              ? 'mt-2 text-4xl font-semibold text-destructive'
              : 'mt-2 text-4xl font-semibold'
          }
        >
          {formatINR(balance.data.balance)}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          What we owe you and have not paid out yet. Negative when refunds since the last settlement
          are more than new payments.
        </p>
      </div>
    </section>
  );
}
