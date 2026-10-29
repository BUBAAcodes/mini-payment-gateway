export type ErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'not_found'
  | 'idempotency_in_progress'
  | 'conflict'
  | 'idempotency_mismatch'
  | 'invalid_state'
  | 'rate_limited'
  | 'internal_error';

export interface ErrorBody {
  error: { code: ErrorCode; message: string; field?: string };
}

/** An error that is safe to show to API callers. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, field?: string) {
    super('validation_error', message, 400, field);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Invalid or missing API key') {
    super('unauthorized', message, 401);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super('not_found', `${resource} not found`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('conflict', message, 409);
  }
}

/** The first request with this Idempotency-Key hasn't finished yet. Retry later. */
export class IdempotencyInProgressError extends AppError {
  constructor() {
    super(
      'idempotency_in_progress',
      'A request with this Idempotency-Key is still in progress. Retry shortly.',
      409,
    );
  }
}

/** The Idempotency-Key was already used for a different request. */
export class IdempotencyMismatchError extends AppError {
  constructor() {
    super(
      'idempotency_mismatch',
      'This Idempotency-Key was already used with a different request body or endpoint.',
      422,
    );
  }
}

export class InvalidStateError extends AppError {
  constructor(message: string) {
    super('invalid_state', message, 422);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests') {
    super('rate_limited', message, 429);
  }
}

/** The JSON body for any thrown value. Unknown errors never leak their message. */
export function toErrorBody(err: unknown): ErrorBody {
  if (err instanceof AppError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.field !== undefined && { field: err.field }),
      },
    };
  }
  return { error: { code: 'internal_error', message: 'Something went wrong' } };
}
