# Build from the repo root:  docker build -f apps/web/Dockerfile .

# ---- base: Node + pnpm (version pinned by package.json "packageManager") ----
FROM node:24-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# ---- deps: download packages using only the lockfile, so this layer caches well ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch

# ---- build: install web and its workspace deps, then `next build` (output: 'standalone') ----
FROM deps AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "web..."
RUN pnpm --filter web build

# ---- runtime: the standalone server and its traced files, as the unprivileged "node" user ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone folder mirrors the repo (outputFileTracingRoot is the repo root). It leaves out
# static assets and public/, which a CDN would normally serve; copy them where server.js looks.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
