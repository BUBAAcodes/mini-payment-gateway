import { formatINR } from '@gateway/shared';
import type { StoreOrder } from './order-store';

// Plain server-rendered HTML, no client JS. Pages that are waiting on a webhook reload themselves
// with <meta http-equiv="refresh">, which is how the order page "flips" to fulfilled.

/** HTML that is already safe: `html` passes it through instead of escaping it again. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

/** A template tag that escapes every interpolated value, unless it is SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  return new SafeHtml(strings.reduce((out, str, i) => out + render(values[i - 1]) + str));
}

/** The one thing the store sells. */
export const PRODUCT = { name: 'T-shirt', description: 'Plain cotton tee', amount: 50_000 };

const STYLES = `
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem;
         color: #1c1917; background: #fafaf9; line-height: 1.5; }
  header { display: flex; justify-content: space-between; align-items: baseline; }
  .tag { font-size: .75rem; background: #fef3c7; padding: .1rem .5rem; border-radius: 999px; }
  .card { background: #fff; border: 1px solid #e7e5e4; border-radius: .75rem; padding: 1.5rem; }
  .price { font-size: 2rem; font-weight: 700; margin: .5rem 0 1rem; }
  button, .button { display: inline-block; font: inherit; font-weight: 600; color: #fff;
         background: #1c1917; border: 0; border-radius: .5rem; padding: .6rem 1.2rem;
         text-decoration: none; cursor: pointer; }
  .status { font-weight: 700; }
  .fulfilled { color: #15803d; } .failed { color: #b91c1c; } .waiting { color: #a16207; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .25rem 1rem; }
  dt { color: #78716c; } dd { margin: 0; font-family: ui-monospace, monospace; }
  .muted { color: #78716c; font-size: .875rem; }
`;

interface LayoutOptions {
  /** Reload (or go to `url`) after this many seconds. */
  refresh?: { seconds: number; url?: string };
}

function layout(title: string, body: SafeHtml, { refresh }: LayoutOptions = {}): string {
  const refreshTag = refresh
    ? html`<meta
        http-equiv="refresh"
        content="${refresh.url ? `${refresh.seconds};url=${refresh.url}` : refresh.seconds}"
      />`
    : '';
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        ${refreshTag}
        <title>${title} · Demo Store</title>
        <style>
          ${new SafeHtml(STYLES)}
        </style>
      </head>
      <body>
        <header>
          <h1><a href="/" style="color: inherit; text-decoration: none">Demo Store</a></h1>
          <span class="tag">Test mode · no real money</span>
        </header>
        ${body}
      </body>
    </html>`.value;
}

export function productPage(): string {
  return layout(
    PRODUCT.name,
    html`<section class="card">
      <h2>${PRODUCT.name}</h2>
      <p>${PRODUCT.description}</p>
      <p class="price">${formatINR(PRODUCT.amount)}</p>
      <form method="post" action="/buy">
        <button type="submit">Buy now</button>
      </form>
      <p class="muted">
        You'll pay on the gateway's test checkout. Try UPI <code>success@test</code>.
      </p>
    </section>`,
  );
}

/** After checkout sends the customer back. The redirect is only a hint; the webhook decides. */
export function callbackConfirmingPage(order: StoreOrder): string {
  const orderUrl = `/orders/${encodeURIComponent(order.id)}`;
  return layout(
    'Confirming payment',
    html`<section class="card">
      <h2>Payment received, confirming…</h2>
      <p>
        We're waiting for the payment gateway to confirm your payment. This takes a few seconds.
      </p>
      <p><a href="${orderUrl}">See your order</a></p>
    </section>`,
    { refresh: { seconds: 2, url: orderUrl } },
  );
}

export function callbackFailedPage(order: StoreOrder): string {
  return layout(
    'Payment not completed',
    html`<section class="card">
      <h2 class="failed">Payment not completed</h2>
      <p>Nothing was charged. You can try again with another payment method.</p>
      <p><a class="button" href="${order.checkoutUrl}">Try again</a></p>
      <p><a href="/orders/${encodeURIComponent(order.id)}">See your order</a></p>
    </section>`,
  );
}

const STATUS_TEXT: Record<StoreOrder['status'], { text: string; className: string }> = {
  awaiting_payment: { text: 'Waiting for payment confirmation…', className: 'waiting' },
  payment_failed: { text: 'Payment failed', className: 'failed' },
  fulfilled: { text: 'Fulfilled ✓ Your T-shirt is on its way.', className: 'fulfilled' },
};

export function orderPage(order: StoreOrder): string {
  const status = STATUS_TEXT[order.status];
  return layout(
    `Order ${order.receipt}`,
    html`<section class="card">
      <h2>Order ${order.receipt}</h2>
      <p class="status ${status.className}">${status.text}</p>
      <dl>
        <dt>Item</dt>
        <dd>${PRODUCT.name}</dd>
        <dt>Amount</dt>
        <dd>${formatINR(order.amount)}</dd>
        <dt>Gateway order</dt>
        <dd>${order.id}</dd>
        <dt>Payment</dt>
        <dd>${order.paymentId ?? '—'}</dd>
        <dt>Fulfilled at</dt>
        <dd>${order.fulfilledAt?.toISOString() ?? '—'}</dd>
      </dl>
      ${
        order.status === 'payment_failed'
          ? html`<p><a class="button" href="${order.checkoutUrl}">Try again</a></p>`
          : ''
      }
      ${
        order.status === 'awaiting_payment'
          ? html`<p class="muted">This page refreshes itself.</p>`
          : ''
      }
    </section>`,
    // Only a webhook changes the order, so keep looking while one may still come.
    order.status === 'awaiting_payment' ? { refresh: { seconds: 2 } } : {},
  );
}

export function errorPage(title: string, message: string): string {
  return layout(
    title,
    html`<section class="card">
      <h2>${title}</h2>
      <p>${message}</p>
      <p><a href="/">Back to the store</a></p>
    </section>`,
  );
}
