import { z } from 'zod';
import { errorResponseSchema } from '@gateway/shared';
import { OPERATIONS, type Auth, type Operation, type Tag } from './operations';

// Builds the OpenAPI 3.1 document from OPERATIONS and the Zod schemas, with Zod 4's own
// z.toJSONSchema(). OpenAPI 3.1 uses JSON Schema 2020-12, so the output fits as it is. Schemas
// with an id (Payment, Order, …) become shared components that operations refer to.

type JsonSchema = Record<string, unknown>;
type Method = Operation['method'];

interface MediaType {
  'application/json': { schema: JsonSchema };
}

export interface OperationObject {
  operationId: string;
  summary: string;
  description?: string;
  tags: [Tag];
  security: Record<string, string[]>[];
  parameters?: JsonSchema[];
  requestBody?: { required: boolean; content: MediaType };
  responses: Record<string, { description: string; headers?: JsonSchema; content?: MediaType }>;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  tags: { name: Tag; description: string }[];
  paths: Record<string, Partial<Record<Method, OperationObject>>>;
  components: { schemas: Record<string, JsonSchema>; securitySchemes: Record<string, JsonSchema> };
}

const DESCRIPTION = `A test-mode payment gateway: create orders, take payments on the hosted checkout, refund
them, get signed webhooks, and see what we pay out to you.

- **Money** is integer paise: ₹500 is \`50000\`. INR only.
- **Auth:** \`Authorization: Bearer sk_test_...\`.
- **Idempotency:** send an \`Idempotency-Key\` on POSTs that create something. A retry with the same
  key returns the first response with \`Idempotent-Replayed: true\` and never creates a second object.
- **Rate limit:** each API key may make a set number of requests a minute (100 by default). Every
  response has \`RateLimit-Limit\`, \`RateLimit-Remaining\` and \`RateLimit-Reset\`; over the limit you
  get \`429\` and a \`Retry-After\` in seconds.
- **Lists** take \`?limit=\` (1–100) and \`?starting_after=\` (the last ID you got) and answer
  \`{ "data": [...], "has_more": true }\`.
- **Errors** always look like \`{ "error": { "code", "message", "field" } }\`.`;

const TAGS: OpenApiDocument['tags'] = [
  { name: 'Merchant', description: "Your server's API. Needs your secret API key." },
  {
    name: 'Checkout',
    description: "The hosted checkout page's API. Needs the order's client secret in `?cs=`.",
  },
  { name: 'Internal', description: 'Daily jobs, called by the cron with INTERNAL_CRON_SECRET.' },
  { name: 'Health', description: 'For load balancers and container health checks.' },
];

const SECURITY_SCHEMES: Record<Exclude<Auth, 'none'>, JsonSchema> = {
  apiKey: { type: 'http', scheme: 'bearer', description: 'Your secret API key, `sk_test_...`.' },
  clientSecret: {
    type: 'apiKey',
    in: 'query',
    name: 'cs',
    description: "The order's `client_secret`, from creating the order.",
  },
  cronSecret: { type: 'http', scheme: 'bearer', description: 'INTERNAL_CRON_SECRET.' },
};

export function buildOpenApiDocument(): OpenApiDocument {
  const schemas: Record<string, JsonSchema> = {};
  const toSchema = (schema: z.ZodType, io: 'input' | 'output') => toJsonSchema(schema, io, schemas);

  const paths: OpenApiDocument['paths'] = {};
  for (const op of OPERATIONS) {
    (paths[op.path] ??= {})[op.method] = operationObject(op, toSchema);
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Gateway API', version: '1.0.0', description: DESCRIPTION },
    tags: TAGS,
    paths,
    components: { schemas, securitySchemes: SECURITY_SCHEMES },
  };
}

type ToSchema = (schema: z.ZodType, io: 'input' | 'output') => JsonSchema;

function operationObject(op: Operation, toSchema: ToSchema): OperationObject {
  const parameters = [
    ...pathParameters(op.path),
    ...(op.query ? queryParameters(op.query, toSchema) : []),
    ...(op.idempotencyKey ? [idempotencyKeyParameter(op.idempotencyKey === 'required')] : []),
  ];
  const json = (schema: z.ZodType, io: 'input' | 'output'): MediaType => ({
    'application/json': { schema: toSchema(schema, io) },
  });

  const responses: OperationObject['responses'] = {};
  for (const [status, { description, schema }] of Object.entries(op.responses)) {
    // Error statuses without their own schema get the standard error body.
    const body = schema ?? (Number(status) >= 400 ? errorResponseSchema : undefined);
    responses[status] = { description, ...(body && { content: json(body, 'output') }) };
  }
  const error = (description: string) => ({
    description,
    content: json(errorResponseSchema, 'output'),
  });
  if (op.body || op.query) responses['400'] ??= error('The input is not valid; `field` says which');
  if (op.auth === 'apiKey' || op.auth === 'cronSecret') {
    responses['401'] ??= error('Missing or wrong credentials');
  }
  if (op.auth === 'apiKey') {
    responses['429'] = {
      ...error('Over the rate limit for this API key'),
      headers: {
        'Retry-After': {
          description: 'Seconds until the limit resets',
          schema: { type: 'integer' },
        },
      },
    };
  }

  return {
    operationId: op.operationId,
    summary: op.summary,
    ...(op.description && { description: op.description }),
    tags: [op.tag],
    security: op.auth === 'none' ? [] : [{ [op.auth]: [] }],
    ...(parameters.length > 0 && { parameters }),
    ...(op.body && {
      requestBody: {
        // A body every field of which is optional may be left out.
        required: !op.body.safeParse({}).success,
        content: json(op.body, 'input'),
      },
    }),
    responses: sortByStatus(responses),
  };
}

function pathParameters(path: string): JsonSchema[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function queryParameters(query: z.ZodObject, toSchema: ToSchema): JsonSchema[] {
  return Object.entries(query.shape).map(([name, field]) => {
    const schema = field as z.ZodType;
    return {
      name,
      in: 'query',
      // Optional and defaulted fields both accept "not sent".
      required: !schema.safeParse(undefined).success,
      schema: toSchema(schema, 'input'),
    };
  });
}

function idempotencyKeyParameter(required: boolean): JsonSchema {
  return {
    name: 'Idempotency-Key',
    in: 'header',
    required,
    description: 'A unique key per operation, such as a UUID. Reuse it only to retry.',
    schema: { type: 'string', maxLength: 255 },
  };
}

/**
 * One schema as JSON Schema. Sub-schemas with an id (and the schema itself, if it has one) go into
 * `components` and are replaced by a $ref to them.
 */
function toJsonSchema(
  schema: z.ZodType,
  io: 'input' | 'output',
  components: Record<string, JsonSchema>,
): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
    override: ({ jsonSchema }) => {
      // .int() adds the safe-integer range to every integer. True, but noise in docs.
      if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum;
      if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
    },
  }) as JsonSchema;
  const { $schema: _, $defs, ...rest } = json;
  for (const [id, definition] of Object.entries(($defs ?? {}) as Record<string, JsonSchema>)) {
    components[id] = toComponentRefs(definition);
  }
  return toComponentRefs(rest);
}

function toComponentRefs(schema: JsonSchema): JsonSchema {
  return JSON.parse(JSON.stringify(schema).replaceAll('"#/$defs/', '"#/components/schemas/'));
}

function sortByStatus<T>(responses: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(responses).sort(([a], [b]) => Number(a) - Number(b)));
}
