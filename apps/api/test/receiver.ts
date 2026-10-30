import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedWebhook {
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Receiver {
  url: string;
  /** Every request, in the order it arrived. */
  received: ReceivedWebhook[];
  /** Stops listening, so later sends fail to connect. */
  close(): Promise<void>;
}

export interface ReceiverOptions {
  /** The status for each request in turn; the last one repeats. */
  statuses?: number[];
  headers?: Record<string, string>;
  /** Waits this long before answering. */
  delayMs?: number;
  /** Never answers at all. */
  hang?: boolean;
}

const servers = new Set<Server>();

function closeServer(server: Server): Promise<void> {
  servers.delete(server);
  return new Promise((resolve) => server.close(() => resolve()).closeAllConnections());
}

/**
 * A merchant's webhook receiver on 127.0.0.1 that records requests. Call stopReceivers() after
 * each test.
 */
export async function startReceiver({
  statuses = [200],
  headers = {},
  delayMs = 0,
  hang = false,
}: ReceiverOptions = {}): Promise<Receiver> {
  const received: ReceivedWebhook[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const status = statuses[Math.min(received.length, statuses.length - 1)] ?? 200;
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (hang) return;
      setTimeout(() => res.writeHead(status, headers).end('ok'), delayMs);
    });
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhooks`,
    received,
    close: () => closeServer(server),
  };
}

export async function stopReceivers(): Promise<void> {
  await Promise.all([...servers].map(closeServer));
}
