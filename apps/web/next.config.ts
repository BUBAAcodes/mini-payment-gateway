import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // `next build` writes .next/standalone: a minimal server.js plus only the files it needs, which is
  // what the Docker image runs. Tracing starts at the repo root so workspace packages are included,
  // and the output mirrors the repo: the server lands at .next/standalone/apps/web/server.js.
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  cacheComponents: true,
  partialPrefetching: true,
  // Workspace packages ship TypeScript source, so Next.js has to compile them.
  transpilePackages: ['@gateway/shared', '@gateway/db'],
  // There is no home page: the site is the dashboard (and /pay checkout links).
  async redirects() {
    return [{ source: '/', destination: '/dashboard', permanent: false }];
  },
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
