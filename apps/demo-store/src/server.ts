import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createStoreApp } from './app';
import { loadConfig } from './config';
import { createGatewayClient } from './gateway-client';
import { createLogger } from './logger';
import { createOrderStore } from './order-store';

// Locally, settings come from the repo's .env (shared with the API). In Docker there is no .env in
// the image and docker-compose sets the environment instead. Variables already set always win.
const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
// The shared .env's PORT is the API's (4000), so the store ignores it and keeps its own default.
const { PORT: _apiPort, ...fileEnv } = existsSync(rootEnv)
  ? parseEnv(readFileSync(rootEnv, 'utf8'))
  : {};

const config = loadConfig({ ...fileEnv, ...process.env });
const logger = createLogger(config.LOG_LEVEL);

const app = createStoreApp({
  config,
  logger,
  orders: createOrderStore(),
  gateway: createGatewayClient({ baseUrl: config.API_BASE_URL, apiKey: config.GATEWAY_SECRET_KEY }),
});

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, storeBaseUrl: config.STORE_BASE_URL, apiBaseUrl: config.API_BASE_URL },
    'demo store listening',
  );
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  // Don't hang forever on keep-alive connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
