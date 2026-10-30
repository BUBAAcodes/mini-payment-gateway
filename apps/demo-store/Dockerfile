# Build from the repo root:  docker build -f apps/demo-store/Dockerfile .

# ---- base: Node + pnpm (version pinned by package.json "packageManager") ----
FROM node:24-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---- deps: download packages using only the lockfile, so this layer caches well ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch

# ---- build: install only the store and its workspace deps, production only ----
# No build step: tsx runs the TypeScript, like the API.
FROM deps AS build
COPY . .
# pnpm fetch left a node_modules set up for dev deps; pnpm won't switch it to --prod without a TTY.
RUN rm -rf node_modules \
 && pnpm install --offline --frozen-lockfile --prod --ignore-scripts --filter "@gateway/demo-store..."

# ---- runtime: only what the store needs, running as the unprivileged "node" user ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/shared ./packages/shared
COPY --from=build --chown=node:node /app/apps/demo-store ./apps/demo-store
USER node
WORKDIR /app/apps/demo-store
EXPOSE 3001
# The slim image has no curl; Node's built-in fetch does the job.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node --import tsx (not the tsx CLI) so Node itself gets SIGTERM directly.
CMD ["node", "--import", "tsx", "src/server.ts"]
