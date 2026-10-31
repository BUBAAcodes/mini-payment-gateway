import { formatINR } from '@gateway/shared';
import { SHIRT_SIZES, type StoreOrder } from './order-store';

// Plain server-rendered HTML, no client JS (helmet's CSP allows no inline scripts anyway). The
// look follows the web app's Blackout-style theme: white, black, two greys, uppercase headings.
// An order page that is waiting on a webhook reloads itself with <meta http-equiv="refresh">,
// which is how it "flips" to fulfilled. It reloads its own URL, so no history entry is added.

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
  :root {
    --bg: #ffffff; --fg: #000000; --card: #f6f6f6; --muted: #ededed; --muted-fg: #757575;
    --line: rgb(0 0 0 / 0.14); --danger: #d10000; --radius: 6px; --radius-card: 10px;
  }
  * { box-sizing: border-box; }
  html { -webkit-font-smoothing: antialiased; }
  body { margin: 0; background: var(--bg); color: var(--fg); line-height: 1.5;
         font-family: Inter, system-ui, -apple-system, 'Segoe UI', sans-serif; }
  a { color: inherit; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
  .display { font-variation-settings: 'opsz' 32; font-weight: 600; letter-spacing: -0.02em;
             text-transform: uppercase; line-height: 1.05; margin: 0; }
  .eyebrow { font-size: 14px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
             color: var(--muted-fg); margin: 0; }
  .muted { color: var(--muted-fg); }
  .nowrap { white-space: nowrap; }
  .small { font-size: 14px; }

  /* Top bar */
  .bar { border-bottom: 1px solid var(--line); }
  .bar .wrap { display: flex; align-items: center; justify-content: space-between; gap: 16px;
               padding-top: 18px; padding-bottom: 18px; }
  .brand { font-variation-settings: 'opsz' 32; font-weight: 600; font-size: 18px;
           letter-spacing: -0.01em; text-decoration: none; }
  .bar nav { display: flex; align-items: center; gap: 20px; }
  .bar nav a { font-size: 14px; font-weight: 500; text-transform: uppercase; color: var(--muted-fg);
               text-decoration: none; }
  .bar nav a:hover { color: var(--fg); }
  .pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px;
          padding: 3px 10px; font-size: 13px; font-weight: 500; white-space: nowrap;
          background: var(--muted); color: var(--fg); }
  .pill.solid { background: var(--fg); color: var(--bg); }
  .pill.danger { background: var(--danger); color: #fff; }

  /* Ticker band */
  .ticker { background: var(--fg); color: var(--bg); overflow: hidden; white-space: nowrap; }
  .ticker .track { display: inline-flex; animation: ticker 30s linear infinite; }
  .ticker span { padding: 14px 0; font-size: 14px; font-weight: 600; letter-spacing: 0.04em; }
  @keyframes ticker { from { transform: translateX(0); } to { transform: translateX(-50%); } }
  @media (prefers-reduced-motion: reduce) { .ticker .track { animation: none; } }

  main { padding: 48px 0 96px; }

  /* Product page */
  .hero { font-size: clamp(56px, 13vw, 168px); margin: 8px 0 40px; }
  .product { display: grid; grid-template-columns: 1.1fr 1fr; gap: 40px; align-items: start; }
  .shot { position: relative; background: var(--card); border-radius: var(--radius-card);
          aspect-ratio: 4 / 5; display: flex; align-items: center; justify-content: center; }
  .shot svg { width: 72%; height: auto; }
  .shot .pill { position: absolute; top: 16px; left: 16px; }
  .details { display: flex; flex-direction: column; gap: 24px; padding-top: 8px; }
  .details h2 { font-size: clamp(32px, 4vw, 44px); }
  .price { font-size: 28px; font-weight: 600; margin: 0; font-variant-numeric: tabular-nums; }
  fieldset { border: 0; margin: 0; padding: 0; }
  legend { padding: 0; margin-bottom: 10px; }
  .sizes { display: flex; gap: 8px; }
  .size input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .size span { display: inline-flex; align-items: center; justify-content: center; min-width: 48px;
               height: 44px; padding: 0 12px; border: 1px solid rgb(0 0 0 / 0.5); border-radius: 2px;
               font-weight: 500; cursor: pointer; }
  .size input:checked + span { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  .size input:focus-visible + span { outline: 2px solid var(--fg); outline-offset: 2px; }
  .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px;
            font: inherit; font-weight: 500; font-size: 16px; color: var(--bg); background: var(--fg);
            border: 1px solid var(--fg); border-radius: var(--radius); padding: 12px 22px;
            text-decoration: none; cursor: pointer; }
  .button:hover { opacity: 0.85; }
  .button.secondary { background: transparent; color: var(--fg); }
  .button.secondary:hover { background: var(--muted); opacity: 1; }
  .button.wide { width: 100%; }
  .hint { background: var(--card); border-radius: var(--radius-card); padding: 16px; margin: 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }

  /* Order and message pages */
  .panel { max-width: 720px; display: flex; flex-direction: column; gap: 28px; }
  .panel h1 { font-size: clamp(36px, 6vw, 56px); }
  .status { display: flex; flex-direction: column; gap: 10px; }
  .status p { margin: 0; font-size: 18px; }
  dl { display: grid; grid-template-columns: 9rem 1fr; gap: 10px 20px; margin: 0;
       background: var(--card); border-radius: var(--radius-card); padding: 20px; }
  dt { color: var(--muted-fg); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; }
  .actions form { margin: 0; }

  footer { border-top: 1px solid var(--line); padding: 32px 0 48px; }
  footer .wrap { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; }

  @media (max-width: 760px) {
    .product { grid-template-columns: 1fr; gap: 28px; }
    .bar nav .pill { display: none; }
    main { padding-top: 32px; }
    dl { grid-template-columns: 1fr; gap: 2px; }
    dd { margin-bottom: 10px; }
  }
`;

const TICKER_TEXT = 'TEST MODE ✱ NO REAL MONEY ✱ ';

interface LayoutOptions {
  /** Reload this same page after this many seconds. Same URL, so no new history entry. */
  refreshSeconds?: number;
}

function layout(title: string, body: SafeHtml, { refreshSeconds }: LayoutOptions = {}): string {
  const refreshTag =
    refreshSeconds === undefined
      ? ''
      : html`<meta http-equiv="refresh" content="${refreshSeconds}" />`;
  const tickerRun = TICKER_TEXT.repeat(6);
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        ${refreshTag}
        <title>${title} · Demo Store</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&display=swap"
        />
        <style>
          ${new SafeHtml(STYLES)}
        </style>
      </head>
      <body>
        <header class="bar">
          <div class="wrap">
            <a class="brand" href="/">DEMO STORE</a>
            <nav aria-label="Store">
              <a href="/">Shop</a>
              <span class="pill">Test mode · no real money</span>
            </nav>
          </div>
        </header>
        <div class="ticker" role="note" aria-label="Test mode. No real money moves.">
          <div class="track" aria-hidden="true">
            <span>${tickerRun}</span><span>${tickerRun}</span>
          </div>
        </div>
        <main>
          <div class="wrap">${body}</div>
        </main>
        <footer>
          <div class="wrap small muted">
            <span>Demo Store · a pretend shop for the Mini Gateway test checkout.</span>
            <span>Orders are kept in memory and reset when the store restarts.</span>
          </div>
        </footer>
      </body>
    </html>`.value;
}

/** A plain black tee, drawn here so the page loads no images (and the CSP needs no img-src). */
const TSHIRT_SVG =
  new SafeHtml(`<svg viewBox="0 0 240 240" role="img" aria-label="A plain black T-shirt">
  <path d="M86 28 L52 40 L18 82 L46 104 L62 88 L62 214 L178 214 L178 88 L194 104 L222 82 L188 40 L154 28
           C150 44 137 54 120 54 C103 54 90 44 86 28 Z" fill="#111" />
  <path d="M86 28 C90 44 103 54 120 54 C137 54 150 44 154 28" fill="none" stroke="#2a2a2a" stroke-width="5" />
  <path d="M62 196 L178 196" stroke="#1d1d1d" stroke-width="2" stroke-dasharray="4 4" />
  <path d="M46 104 L62 88 M194 104 L178 88" stroke="#1d1d1d" stroke-width="2" />
  <text x="120" y="128" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="13"
        font-weight="600" letter-spacing="2" fill="#f6f6f6">DEMO STORE</text>
</svg>`);

export function productPage(): string {
  const sizes = SHIRT_SIZES.map(
    (size) =>
      html`<label class="size">
        <input
          type="radio"
          name="size"
          value="${size}"
          ${size === 'M' ? new SafeHtml('checked') : ''}
        />
        <span>${size}</span>
      </label>`,
  );
  return layout(
    PRODUCT.name,
    html`<p class="eyebrow">01 / ${PRODUCT.description}</p>
      <h1 class="display hero">Demo Store</h1>
      <section class="product" aria-labelledby="product-name">
        <div class="shot">
          <span class="pill solid">New</span>
          ${TSHIRT_SVG}
        </div>
        <form class="details" method="post" action="/buy">
          <p class="eyebrow">Just dropped</p>
          <h2 id="product-name" class="display">
            Plain cotton <span class="nowrap">${PRODUCT.name}</span>
          </h2>
          <p class="price">${formatINR(PRODUCT.amount)}</p>
          <p class="muted" style="margin: 0">
            Heavyweight cotton, relaxed fit. The only thing we sell, so we made it good.
          </p>
          <fieldset>
            <legend class="eyebrow">Size</legend>
            <div class="sizes">${sizes}</div>
          </fieldset>
          <button class="button wide" type="submit">Buy now</button>
          <p class="hint small">
            You'll pay on the gateway's <strong>test</strong> checkout. Try UPI
            <code>success@test</code>, or card <code>4111 1111 1111 1111</code> with OTP
            <code>123456</code>.
          </p>
        </form>
      </section>`,
  );
}

interface OrderPageOptions {
  /**
   * Checkout's redirect said the payment failed. That status isn't signed, so it only picks the
   * message; the order itself changes only when a webhook arrives.
   */
  checkoutSaidFailed?: boolean;
}

/** What the order page says, and whether it keeps reloading to wait for a webhook. */
function orderStatus(order: StoreOrder, { checkoutSaidFailed }: OrderPageOptions) {
  if (order.status === 'fulfilled') {
    return {
      pill: html`<span class="pill solid">Fulfilled</span>`,
      headline: 'Thank you!',
      message: `Payment confirmed. Your ${PRODUCT.name} is on its way.`,
      tryAgain: false,
      waiting: false,
    };
  }
  if (order.status === 'payment_failed') {
    return {
      pill: html`<span class="pill danger">Payment failed</span>`,
      headline: 'Payment failed',
      message: 'Nothing was charged. You can try again with another payment method.',
      tryAgain: true,
      waiting: false,
    };
  }
  if (checkoutSaidFailed) {
    return {
      pill: html`<span class="pill danger">Payment not completed</span>`,
      headline: 'Not completed',
      message: 'Nothing was charged. You can try again with another payment method.',
      tryAgain: true,
      waiting: false,
    };
  }
  return {
    pill: html`<span class="pill">Confirming…</span>`,
    headline: 'Almost there',
    message: 'Payment received, confirming… This takes a few seconds; the page updates itself.',
    tryAgain: false,
    waiting: true,
  };
}

const indiaTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function orderPage(order: StoreOrder, options: OrderPageOptions = {}): string {
  const status = orderStatus(order, options);
  return layout(
    `Order ${order.receipt}`,
    html`<section class="panel">
      <div>
        <p class="eyebrow">Order ${order.receipt}</p>
        <h1 class="display">${status.headline}</h1>
      </div>
      <div class="status" role="status">
        <div>${status.pill}</div>
        <p>${status.message}</p>
      </div>
      <dl>
        <dt>Item</dt>
        <dd>${PRODUCT.name}, Size ${order.size}</dd>
        <dt>Amount</dt>
        <dd>${formatINR(order.amount)}</dd>
        <dt>Gateway order</dt>
        <dd><code>${order.id}</code></dd>
        <dt>Payment</dt>
        <dd><code>${order.paymentId ?? '—'}</code></dd>
        <dt>Fulfilled at</dt>
        <dd>${order.fulfilledAt ? `${indiaTime.format(order.fulfilledAt)} IST` : '—'}</dd>
      </dl>
      <div class="actions">
        ${status.tryAgain ? html`<a class="button" href="${order.checkoutUrl}">Try again</a>` : ''}
        <a class="button secondary" href="/">Continue shopping</a>
        <form method="post" action="/buy">
          <input type="hidden" name="size" value="${order.size}" />
          <button class="button secondary" type="submit">Buy another</button>
        </form>
      </div>
    </section>`,
    // Only a webhook changes the order, so keep looking while one may still come.
    status.waiting ? { refreshSeconds: 2 } : {},
  );
}

export function errorPage(title: string, message: string): string {
  return layout(
    title,
    html`<section class="panel">
      <h1 class="display">${title}</h1>
      <p style="margin: 0; font-size: 18px">${message}</p>
      <div class="actions"><a class="button" href="/">Back to the shop</a></div>
    </section>`,
  );
}
