import { notFound } from 'next/navigation';
import { formatINR, isId } from '@gateway/shared';
import { CheckoutFlow } from '@/components/checkout/checkout-flow';
import { screenFor, type CheckoutPayment } from '@/lib/checkout';
import { getCheckoutOrder, getCheckoutPayment } from '@/lib/gateway-api';

interface CheckoutProps {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Loads the order with its client secret and picks the first screen. A refreshed page carries on
 * from the newest attempt: back at the OTP, still processing, or the result.
 */
export async function Checkout({ params, searchParams }: CheckoutProps) {
  const { orderId } = await params;
  const { cs } = await searchParams;
  // A wrong ID and a wrong secret look the same, as they do in the API.
  if (typeof cs !== 'string' || !isId('order', orderId)) notFound();

  const order = await getCheckoutOrder(orderId, cs);
  if (!order.ok) {
    if (order.error.code === 'not_found') notFound();
    return <p role="alert">{order.error.message}</p>;
  }

  let latestPayment: CheckoutPayment | null = null;
  const latest = order.data.latest_payment;
  if (latest && screenFor(latest) !== 'form') {
    const payment = await getCheckoutPayment(latest.id, cs);
    if (!payment.ok) return <p role="alert">{payment.error.message}</p>;
    latestPayment = payment.data;
  }

  return (
    <CheckoutFlow
      order={{
        id: order.data.id,
        cs,
        merchantName: order.data.merchant_name,
        amountLabel: formatINR(order.data.amount),
      }}
      initialPayment={latestPayment}
    />
  );
}
