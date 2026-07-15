import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './env.js';
import { sendError } from './lib/http.js';
import { authRouter } from './auth/routes.js';
import { assetsRouter } from './routes/assets.js';
import { uploadsRouter } from './routes/uploads.js';
import { favoritesRouter } from './routes/favorites.js';
import { collectionsRouter } from './routes/collections.js';
import { notificationsRouter } from './routes/notifications.js';
import { downloadsRouter } from './routes/downloads.js';
import { creatorsRouter } from './routes/creators.js';

const limiter = (windowMs: number, limit: number) => rateLimit({
  windowMs,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
});

export function createApp() {
  const app = express();
  if (env.NODE_ENV === 'production') app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
    credentials: true,
  }));
  app.use((req, res, next) => {
    const requestId = req.header('x-request-id') || randomUUID();
    res.setHeader('x-request-id', requestId);
    const startedAt = Date.now();
    res.on('finish', () => {
      if (env.NODE_ENV !== 'test') {
        console.log(JSON.stringify({
          level: 'info', event: 'http_request', requestId,
          method: req.method, path: req.originalUrl, status: res.statusCode,
          durationMs: Date.now() - startedAt,
        }));
      }
    });
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  const healthPayload = () => ({
    ok: true, service: 'kontaner-backend', env: env.NODE_ENV, version: '0.7.0',
    routes: ['auth', 'assets', 'uploads', 'favorites', 'collections', 'notifications', 'downloads', 'creators'],
  });
  app.get('/health', (_req, res) => res.json(healthPayload()));
  app.get('/api/health', (_req, res) => res.json(healthPayload()));

  app.use('/api/auth', limiter(15 * 60_000, 30), authRouter);
  app.use('/api/assets', limiter(60_000, 180), assetsRouter);
  app.use('/api/uploads', limiter(60 * 60_000, 30), uploadsRouter);
  app.use('/api/favorites', favoritesRouter);
  app.use('/api/collections', collectionsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/downloads', limiter(60_000, 60), downloadsRouter);
  app.use('/api/creators', limiter(60_000, 120), creatorsRouter);

  app.use((_req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => sendError(res, err));
  return app;
}
