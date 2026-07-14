import { createApp } from './app.js';
import { env } from './env.js';

const server = createApp().listen(env.PORT, () => {
  console.log(`▶ kontaner-backend listening on http://localhost:${env.PORT}`);
  console.log(`  CORS origin: ${env.CORS_ORIGIN}`);
  console.log(`  Env: ${env.NODE_ENV}`);
});

const shutdown = (signal: string): void => {
  console.log(`${signal} received; shutting down`);
  server.close((err) => {
    if (err) {
      console.error('Graceful shutdown failed:', err);
      process.exit(1);
    }
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
