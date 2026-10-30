import { Suspense } from 'react';
import { CheckoutSkeleton } from '@/components/checkout/checkout-skeleton';
import { Checkout } from './checkout';

/**
 * /pay/{orderId}?cs=…, the merchant's checkout_url. The order is request-time data, so it loads
 * inside Suspense: the frame streams at once and the payment screen follows (Cache Components).
 */
export default function PayPage({ params, searchParams }: PageProps<'/pay/[orderId]'>) {
  return (
    <Suspense fallback={<CheckoutSkeleton />}>
      <Checkout params={params} searchParams={searchParams} />
    </Suspense>
  );
}
