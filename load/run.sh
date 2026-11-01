#!/usr/bin/env bash
# `pnpm test:load`: the k6 idempotency test (section 15, optional) against Docker on this machine.
#
# Like the e2e suite, it brings up its own stack (Compose project gateway-load) from an empty
# database with fresh secrets, so it never depends on your .env or touches the dev database:
#  1. Postgres and Redis, then migrations and the seed (for an API key).
#  2. The API, with a rate limit high enough that 200 requests on one key aren't turned into 429s.
#  3. k6 sends 200 POST /v1/orders with one Idempotency-Key at the same moment.
#  4. Postgres must hold exactly one order with this run's receipt (rule 2).
# The stack is removed at the end (LOAD_KEEP_STACK=1 keeps it). It publishes the same ports as the
# dev stack, so stop that first (`docker compose down`).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

compose() { docker compose -p gateway-load -f "$repo_root/docker-compose.yml" "$@"; }
step() { echo "[load] $*"; }

# Fresh secrets every run. Compose checks every service's required variables, web's included.
export APP_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export INTERNAL_CRON_SECRET="$(openssl rand -hex 32)"
export DASHBOARD_SERVICE_TOKEN="$(openssl rand -hex 32)"
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
export RATE_LIMIT_PER_MINUTE=1000000
export DATABASE_URL="postgresql://gateway:gateway@localhost:5432/gateway"
export DIRECT_DATABASE_URL="$DATABASE_URL"
export STORE_BASE_URL="http://localhost:3001"
# Nothing listens there; the seeded endpoint only has to exist.
export STORE_WEBHOOK_URL="http://demo-store:3001/webhooks/gateway"

teardown() {
  if [[ "${LOAD_KEEP_STACK:-}" == "1" ]]; then
    step "LOAD_KEEP_STACK=1: leaving the stack running (docker compose -p gateway-load down -v)"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap teardown EXIT

compose down -v --remove-orphans >/dev/null 2>&1 || true

step "Starting Postgres and Redis"
compose up -d --wait postgres redis

step "Migrating and seeding"
pnpm --silent --filter @gateway/db exec prisma migrate deploy >/dev/null
api_key="$(pnpm --silent --filter @gateway/e2e exec tsx stack/seed.ts |
  node -e 'process.stdin.on("data", (d) => process.stdout.write(JSON.parse(d).apiKey))')"

step "Building and starting the API"
compose up -d --build --wait api

run_id="load-$(date +%s)"
mkdir -p load/results

step "Sending 200 requests with one Idempotency-Key"
# k6 runs as its own user; run it as you so it can write load/results on the bind mount.
compose --profile load run --rm --no-deps --user "$(id -u):$(id -g)" \
  -e API_KEY="$api_key" -e IDEMPOTENCY_KEY="$run_id" -e RECEIPT="$run_id" \
  k6 run --quiet /load/idempotency.js

orders="$(compose exec -T postgres psql -U gateway -d gateway -tAc \
  "SELECT count(*) FROM orders WHERE receipt = '$run_id'")"
step "Orders created: $orders"
if [[ "$orders" != "1" ]]; then
  step "FAIL: expected exactly one order"
  exit 1
fi
step "PASS: one order. Full k6 summary in load/results/idempotency.json"
