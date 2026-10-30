import { randomBytes } from 'node:crypto';
import { apiReference } from '@scalar/express-api-reference';
import { Router } from 'express';
import { buildOpenApiDocument } from '../openapi';

/**
 * Scalar's page script, pinned to an exact version: an unpinned CDN URL would run whatever was
 * published last. Too big (~5 MB) to ship in our image.
 */
const SCALAR_SCRIPT =
  'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.4/dist/browser/standalone.js';

/**
 * The docs page needs more than helmet's default policy: Scalar's script from the CDN, its inline
 * start-up script, and the styles it injects. Scripts are allowed by a nonce, fresh per request,
 * that only our own two script tags carry; everything else stays as strict as the default.
 */
function docsContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' https://fonts.scalar.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** GET /openapi.json (the document) and GET /docs (Scalar's API reference for it). */
export function docsRouter(): Router {
  const router = Router();
  // Built once: the document only changes with the code.
  const document = buildOpenApiDocument();

  router.get('/openapi.json', (_req, res) => {
    res.json(document);
  });

  router.get('/docs', (req, res, next) => {
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', docsContentSecurityPolicy(nonce));
    const render = apiReference({
      url: '/openapi.json',
      cdn: SCALAR_SCRIPT,
      nonce,
      pageTitle: 'Gateway API',
      // Scalar's own extras: a "deploy" toolbar on localhost and an AI chat that calls its servers.
      showDeveloperTools: 'never',
      agent: { disabled: true },
    });
    // Scalar types its handler's request as Request<never>; it never reads it.
    render(req as never, res, next);
  });

  return router;
}
