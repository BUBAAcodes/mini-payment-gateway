// k6 load test (section 15, optional): 200 virtual users send POST /v1/orders with the same
// Idempotency-Key at the same moment. Rule 2 says that makes exactly one order. k6 can only see each
// response, so run.sh counts the orders in Postgres afterwards; this script checks that every
// response is a 201 (the first request or a replay of it) or a 409 (the first is still running).
// Run it with `pnpm test:load`, never against a deployed API (section 19).
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const API_URL = __ENV.API_URL || 'http://api:4000';
const VUS = Number(__ENV.VUS || 200);

const created = new Counter('orders_201');
const replayed = new Counter('orders_201_replayed');
const inProgress = new Counter('orders_409_in_progress');

export const options = {
  scenarios: {
    same_key: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '1m' },
  },
  thresholds: { checks: ['rate==1'] },
};

export default function () {
  const res = http.post(
    `${API_URL}/v1/orders`,
    JSON.stringify({ amount: 50000, currency: 'INR', receipt: __ENV.RECEIPT }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${__ENV.API_KEY}`,
        'Idempotency-Key': __ENV.IDEMPOTENCY_KEY,
      },
    },
  );

  if (res.status === 201) {
    created.add(1);
    if (res.headers['Idempotent-Replayed'] === 'true') replayed.add(1);
  }
  if (res.status === 409) inProgress.add(1);

  check(res, {
    '201 with an order, or 409 idempotency_in_progress': (r) =>
      (r.status === 201 && /^order_/.test(r.json('id'))) ||
      (r.status === 409 && r.json('error.code') === 'idempotency_in_progress'),
  });
}

// Replaces k6's default summary, which needs a remote import, with the numbers that matter here.
export function handleSummary(data) {
  const ms = (v) => `${v.toFixed(1)} ms`;
  const d = data.metrics.http_req_duration.values;
  const count = (name) => (data.metrics[name] ? data.metrics[name].values.count : 0);
  const text = [
    '',
    `requests            ${data.metrics.http_reqs.values.count} (${VUS} VUs, one Idempotency-Key)`,
    `201                 ${count('orders_201')} (${count('orders_201_replayed')} replayed)`,
    `409 in progress     ${count('orders_409_in_progress')}`,
    `checks passed       ${(data.metrics.checks.values.rate * 100).toFixed(1)}%`,
    `latency             med ${ms(d.med)} · p90 ${ms(d['p(90)'])} · p95 ${ms(d['p(95)'])} · max ${ms(d.max)}`,
    '',
  ].join('\n');
  return { stdout: text, '/load/results/idempotency.json': JSON.stringify(data, null, 2) };
}
