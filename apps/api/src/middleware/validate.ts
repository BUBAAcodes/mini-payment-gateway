import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { ValidationError } from '@gateway/shared';

interface Schemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

/**
 * Validates request parts with Zod. Parsed values go to `res.locals.validated`,
 * because Express 5 makes `req.query` read-only. The first problem becomes a 400.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, res, next) => {
    const validated: Record<string, unknown> = {};
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        const issue = result.error.issues[0];
        const field = issue?.path.length ? issue.path.join('.') : undefined;
        throw new ValidationError(issue?.message ?? `Invalid ${part}`, field);
      }
      validated[part] = result.data;
    }
    res.locals.validated = validated;
    next();
  };
}
