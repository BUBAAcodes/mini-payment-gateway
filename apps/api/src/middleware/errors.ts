import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, NotFoundError, toErrorBody } from '@gateway/shared';

export const notFoundHandler: RequestHandler = () => {
  throw new NotFoundError('Route');
};

/** body-parser errors carry a `type` such as 'entity.parse.failed'. */
function bodyParserErrorType(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'type' in err && typeof err.type === 'string') {
    return err.type;
  }
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json(toErrorBody(err));
    return;
  }

  switch (bodyParserErrorType(err)) {
    case 'entity.parse.failed':
      res.status(400).json({ error: { code: 'validation_error', message: 'Malformed JSON body' } });
      return;
    case 'entity.too.large':
      res
        .status(413)
        .json({ error: { code: 'validation_error', message: 'Request body too large' } });
      return;
  }

  // Unknown error: log everything, tell the caller nothing.
  req.log.error({ err }, 'unhandled error');
  res.status(500).json(toErrorBody(err));
};
