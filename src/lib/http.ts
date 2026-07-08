import type { Response } from 'express';

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code?: string): HttpError =>
  new HttpError(400, message, code);

export const unauthorized = (message = 'Unauthorized'): HttpError =>
  new HttpError(401, message, 'UNAUTHORIZED');

export const forbidden = (message = 'Forbidden'): HttpError =>
  new HttpError(403, message, 'FORBIDDEN');

export const notFound = (message = 'Not found'): HttpError =>
  new HttpError(404, message, 'NOT_FOUND');

export const conflict = (message: string, code?: string): HttpError =>
  new HttpError(409, message, code);

/** Standard error envelope the frontend already understands. */
export function sendError(res: Response, err: unknown): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
