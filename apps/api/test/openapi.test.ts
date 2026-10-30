import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '@gateway/db';
import { buildOpenApiDocument, type OpenApiDocument } from '../src/openapi';
import { testApp } from './helpers';

// Never queried: these tests only look at routes and documents.
const db = createPrismaClient('postgresql://localhost/unused');
const app = testApp(db);

const HTTP_METHODS = ['get', 'post', 'delete'] as const;
/** Where app.ts mounts each router. Express doesn't keep mount paths, so the test strips them. */
const MOUNT_PREFIXES = ['/v1', '/checkout', '/internal'];
/** The docs' own routes. */
const DOCS_ROUTES = ['GET /openapi.json', 'GET /docs'];

let doc: OpenApiDocument;

beforeAll(() => {
  doc = buildOpenApiDocument();
});

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  /** True for routers mounted at "/". */
  slash: boolean;
  match(path: string): unknown;
}

/**
 * The dashboard API is private to the web app's server (it needs DASHBOARD_SERVICE_TOKEN), so the
 * public docs leave it out. It reuses the merchant routers, so it is skipped by its mount path.
 */
const isDashboard = (layer: Layer) => !layer.slash && Boolean(layer.match('/dashboard'));

/** Every route in the app as "METHOD /path", relative to the router it lives in. */
function appRoutes(stack: Layer[]): string[] {
  return stack.flatMap((layer) => {
    if (isDashboard(layer)) return [];
    if (layer.route) {
      const { path, methods } = layer.route;
      return Object.keys(methods)
        .filter((m) => m !== '_all')
        .map((m) => `${m.toUpperCase()} ${path}`);
    }
    return layer.handle?.stack ? appRoutes(layer.handle.stack) : [];
  });
}

function operations(document: OpenApiDocument) {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter((m) => item[m]).map((method) => ({ path, method, op: item[method]! })),
  );
}

/** /v1/orders/{id} → "GET /orders/:id", the way Express sees it. */
function asExpressRoute(method: string, path: string): string {
  const prefix = MOUNT_PREFIXES.find((p) => path.startsWith(`${p}/`)) ?? '';
  return `${method.toUpperCase()} ${path.slice(prefix.length).replace(/\{(\w+)\}/g, ':$1')}`;
}

describe('the OpenAPI document', () => {
  it('documents every route in the app, and nothing that is not a route', () => {
    const router = (app as unknown as { router: { stack: Layer[] } }).router;
    const routes = appRoutes(router.stack).filter((r) => !DOCS_ROUTES.includes(r));
    const documented = operations(doc).map(({ method, path }) => asExpressRoute(method, path));

    expect(documented.sort()).toEqual(routes.sort());
    // Every merchant route from the spec's API table (section 8).
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/orders',
        '/v1/orders/{id}',
        '/v1/payments',
        '/v1/payments/{id}',
        '/v1/payments/{id}/refunds',
        '/v1/refunds/{id}',
        '/v1/webhook_endpoints',
        '/v1/webhook_endpoints/{id}',
        '/v1/webhook_endpoints/{id}/test',
        '/v1/events',
        '/v1/events/{id}/redeliver',
        '/v1/balance',
        '/v1/settlements',
      ]),
    );
  });

  it('gives every operation a unique ID, a tag, a summary and a success response with a schema', () => {
    const ids = operations(doc).map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);

    for (const { method, path, op } of operations(doc)) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(op.tags, where).toHaveLength(1);
      expect(['Merchant', 'Checkout', 'Internal', 'Health'], where).toContain(op.tags[0]);
      expect(op.summary, where).toBeTruthy();
      const success = Object.keys(op.responses).find((status) => status.startsWith('2'));
      expect(success, where).toBeDefined();
      expect(op.responses[success!]!.content?.['application/json']?.schema, where).toBeDefined();
    }
  });

  it('requires an API key on the merchant API, and documents its 401 and 429', () => {
    for (const { path, op } of operations(doc).filter(({ path }) => path.startsWith('/v1/'))) {
      expect(op.security, path).toEqual([{ apiKey: [] }]);
      expect(Object.keys(op.responses), path).toEqual(expect.arrayContaining(['401', '429']));
    }
  });

  it('points every $ref at a schema it defines', () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of new Set(refs)) {
      expect(ref).toMatch(/^#\/components\/schemas\//);
      expect(doc.components.schemas, ref).toHaveProperty(ref.split('/').pop()!);
    }
    expect(JSON.stringify(doc)).not.toContain('$defs');
  });

  it('describes request bodies as callers send them: defaults are optional', () => {
    const body = doc.paths['/v1/orders']!.post!.requestBody!.content['application/json'].schema;
    expect(body).toMatchObject({ type: 'object', required: ['amount'] });
    expect(doc.paths['/v1/orders']!.post!.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]),
    );
  });
});

describe('the Bruno collection', () => {
  const collection = fileURLToPath(new URL('../../../docs/bruno', import.meta.url));

  const SETTINGS_FILES = ['collection.bru', 'folder.bru'];

  function bruFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'environments' ? [] : bruFiles(path);
      // collection.bru and folder.bru hold settings, not requests.
      const isRequest = entry.name.endsWith('.bru') && !SETTINGS_FILES.includes(entry.name);
      return isRequest ? [path] : [];
    });
  }

  it('has a request for every documented operation', () => {
    const requests = bruFiles(collection).map((file) => {
      const text = readFileSync(file, 'utf8');
      const match = /^(get|post|put|patch|delete) \{\s*url: \{\{baseUrl\}\}([^\s?]+)/m.exec(text);
      if (!match) throw new Error(`${file} has no request line`);
      return { method: match[1]!, path: match[2]! };
    });

    for (const { method, path } of operations(doc)) {
      const pattern = new RegExp(`^${path.replace(/\{\w+\}/g, '\\{\\{\\w+\\}\\}')}$`);
      expect(
        requests.some((r) => r.method === method && pattern.test(r.path)),
        `${method.toUpperCase()} ${path}`,
      ).toBe(true);
    }
  });
});

describe('GET /openapi.json and GET /docs', () => {
  it('serves the document', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it('serves the Scalar page, its scripts allowed by a fresh nonce and nothing else', async () => {
    const first = await request(app).get('/docs');
    const second = await request(app).get('/docs');

    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/text\/html/);
    expect(first.text).toContain('/openapi.json');

    const csp = first.headers['content-security-policy'] as string;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(first.text).toContain(`nonce="${nonce}"`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(second.headers['content-security-policy']).not.toContain(nonce);
  });

  it('keeps the strict default policy everywhere else', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
  });
});
