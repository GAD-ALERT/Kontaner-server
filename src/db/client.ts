import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

/**
 * Neon-friendly connection.
 * - `max: 20` fits Neon's pooler default.
 * - `prepare: false` because Neon's pooler doesn't support prepared statements.
 */
const client = postgres(env.DATABASE_URL, {
  max: 20,
  idle_timeout: 30,
  prepare: false,
});

export const db = drizzle(client, { schema });
export type Db = typeof db;

export { schema };
