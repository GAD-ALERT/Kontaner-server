import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { env } from './env.js';
import { sendError } from './lib/http.js';
import { authRouter } from './auth/routes.js';
import { assetsRouter } from './routes/assets.js';
import { uploadsRouter } from './routes/uploads.js';
import { favoritesRouter } from './routes/favorites.js';
import { collectionsRouter } from './routes/collections.js';
import { notificationsRouter } from './routes/notifications.js';
import { downloadsRouter } from './routes/downloads.js';

const app = express();

app.use(
  cors({
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  }),
);
app.use(express.json({ limit: '2mb' }));

/* Health */
const healthPayload = () => ({
  ok: true,
  service: 'kontaner-backend',
  env: env.NODE_ENV,
  version: '0.5.0',
  routes: [
    'auth',
    'assets',
    'uploads',
    'favorites',
    'collections',
    'notifications',
    'downloads',
  ],
});
app.get('/health', (_req, res) => res.json(healthPayload()));
app.get('/api/health', (_req, res) => res.json(healthPayload()));

/* API v1 */
app.use('/api/auth', authRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/favorites', favoritesRouter);
app.use('/api/collections', collectionsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/downloads', downloadsRouter);

/* 404 */
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/* Central error handler */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  sendError(res, err);
});

app.listen(env.PORT, () => {
  console.log(
    `▶ kontaner-backend listening on http://localhost:${env.PORT}`,
  );
  console.log(`  CORS origin: ${env.CORS_ORIGIN}`);
  console.log(`  Env: ${env.NODE_ENV}`);
});
