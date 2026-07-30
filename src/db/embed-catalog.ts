import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { assets } from './schema.js';
import { eq } from 'drizzle-orm';
import { embedText } from '../lib/gemini.js';
import { embeddingCorpus } from '../lib/search.js';

/**
 * Backfill embeddings for assets.
 * Default: idempotent — only embeds rows that don't have one yet.
 * `--force` / `--all`: re-embeds every asset. Use this once after changing
 *   the embedding model or task type so old vectors match the new ones.
 */
async function main(): Promise<void> {
  const force = process.argv.includes('--force') || process.argv.includes('--all');

  const rows = await db
    .select({
      id: assets.id,
      displayTitle: assets.displayTitle,
      tags: assets.tags,
      aiInsight: assets.aiInsight,
      ownerLabel: assets.ownerLabel,
    })
    .from(assets)
    .where(force ? undefined : sql`${assets.embedding} IS NULL`);

  if (rows.length === 0) {
    console.log('✓ All assets already embedded');
    process.exit(0);
  }

  console.log(`▶ Embedding ${rows.length} assets${force ? ' (force: re-embedding all)' : ''}…`);

  let done = 0;
  const startedAt = Date.now();

  for (const row of rows) {
    const corpus = embeddingCorpus({
      displayTitle: row.displayTitle,
      tags: row.tags,
      aiInsight: row.aiInsight,
      ownerLabel: row.ownerLabel,
    });
    try {
      const vec = await embedText(corpus);
      if (vec.length === 0) {
        console.warn(`  ⚠ empty embedding for ${row.id}, skipping`);
        continue;
      }
      await db
        .update(assets)
        .set({ embedding: vec })
        .where(eq(assets.id, row.id));
      done++;
      if (done % 5 === 0) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`  · ${done}/${rows.length} (${elapsed}s)`);
      }
    } catch (err) {
      console.warn(`  ⚠ ${row.id} failed:`, err);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`✓ Embedded ${done}/${rows.length} in ${elapsed}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ Embed backfill failed:', err);
  process.exit(1);
});
