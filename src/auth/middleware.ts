import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { unauthorized } from '../lib/http.js';

export interface JwtPayload {
  sub: string;  // user id
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/** Signs a JWT for a logged-in user. */
export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Strict auth guard — throws 401 if no valid JWT.
 * The frontend fetch wrapper redirects to /login on 401.
 */
export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(unauthorized('Missing bearer token'));
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    req.user = decoded;
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}

/**
 * Soft auth — attaches req.user if a token is present, but
 * never blocks. Used on browse endpoints so we can personalise
 * (e.g. "is favorited") without forcing login.
 */
export function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();
  const token = header.slice('Bearer '.length).trim();
  try {
    req.user = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    // silently ignore — public browsing still works
  }
  next();
}
