import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { assets } from './schema.js';
import { eq } from 'drizzle-orm';
import { embedText } from '../lib/gemini.js';
import { embeddingCorpus } from '../lib/search.js';

/**
 * Backfill embeddings for every asset that doesn't have one yet.
 * Idempotent — re-running skips already-embedded rows.
 */
async function main(): Promise<void> {
  const rows = await db
    .select({
      id: assets.id,
      displayTitle: assets.displayTitle,
      tags: assets.tags,
      aiInsight: assets.aiInsight,
      ownerLabel: assets.ownerLabel,
    })
    .from(assets)
    .where(sql`${assets.embedding} IS NULL`);

  if (rows.length === 0) {
    console.log('✓ All assets already embedded');
    process.exit(0);
  }

  console.log(`▶ Embedding ${rows.length} assets…`);

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
