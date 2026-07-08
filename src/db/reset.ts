import { sql } from 'drizzle-orm';
import { db } from './client.js';

/**
 * Drops every table under the current schema so migrations can rebuild
 * from scratch. Guarded to non-production environments.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('✗ Refusing to reset in production');
    process.exit(1);
  }
  console.log('▶ Dropping all tables…');
  await db.execute(sql`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO public;
  `);
  console.log('✓ Schema reset. Run: npm run db:migrate && npm run db:seed');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ Reset failed:', err);
  process.exit(1);
});
