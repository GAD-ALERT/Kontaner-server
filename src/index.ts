import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { env } from './env.js';
import { sendError } from './lib/http.js';
import { authRouter } from './auth/routes.js';

const app = express();

app.use(
  cors({
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  }),
);
app.use(express.json({ limit: '2mb' }));

/* Health */
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'kontaner-backend', env: env.NODE_ENV });
});

/* API v1 */
app.use('/api/auth', authRouter);

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
