import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConflictError,
  InvalidStateError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
  toErrorBody,
} from './errors';

describe('error classes', () => {
  it.each([
    [new ValidationError('bad amount', 'amount'), 400, 'validation_error'],
    [new UnauthorizedError(), 401, 'unauthorized'],
    [new NotFoundError('payment'), 404, 'not_found'],
    [new ConflictError('order already paid'), 409, 'conflict'],
    [new InvalidStateError('payment is not captured'), 422, 'invalid_state'],
    [new RateLimitedError(), 429, 'rate_limited'],
  ] as const)('%s has the right status and code', (err, status, code) => {
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
  });
});

describe('toErrorBody', () => {
  it('wraps an AppError in the API error shape', () => {
    expect(toErrorBody(new ValidationError('must be at least 100', 'amount'))).toEqual({
      error: { code: 'validation_error', message: 'must be at least 100', field: 'amount' },
    });
  });

  it('leaves out field when there is none', () => {
    expect(toErrorBody(new NotFoundError('payment'))).toEqual({
      error: { code: 'not_found', message: 'payment not found' },
    });
  });

  it('hides the message of unknown errors', () => {
    expect(toErrorBody(new Error('db password is hunter2'))).toEqual({
      error: { code: 'internal_error', message: 'Something went wrong' },
    });
  });
});
