# Build from the repo root:  docker build -f apps/api/Dockerfile .

# ---- base: Node + pnpm (version pinned by package.json "packageManager") ----
FROM node:24-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---- deps: download packages using only the lockfile, so this layer caches well ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch

# ---- build: install, generate the Prisma client, then prune to production deps ----
FROM deps AS build
# Prisma's engine download checks for OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@gateway/api..."
RUN pnpm --filter @gateway/db generate
# Reinstall with production deps only. Scripts are skipped because prisma (a dev dep) is gone
# and the client generated above stays in packages/db/src/generated.
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
 && pnpm install --offline --frozen-lockfile --prod --ignore-scripts --filter "@gateway/api..."

# ---- runtime: only what the API needs, running as the unprivileged "node" user ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/api ./apps/api
USER node
WORKDIR /app/apps/api
EXPOSE 4000
# The slim image has no curl; Node's built-in fetch does the job.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node --import tsx (not the tsx CLI) so Node itself is PID 1's child and gets SIGTERM directly.
CMD ["node", "--import", "tsx", "src/server.ts"]
