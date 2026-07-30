import { eq, sql } from 'drizzle-orm';
import { db } from './client.js';
import { assets } from './schema.js';
import { tagAndDescribeImage, embedText } from '../lib/gemini.js';
import { embeddingCorpus } from '../lib/search.js';

/**
 * Re-run Gemini vision analysis over existing assets.
 *
 * Assets uploaded while the vision model was misconfigured got filename-derived
 * fallback tags and a placeholder insight. This script re-downloads each image
 * from its stored URL, re-tags it with the (now working) vision model, and
 * re-embeds the refreshed corpus so semantic search has real signal.
 *
 * Usage:
 *   tsx src/db/reanalyze-catalog.ts            # only fallback/placeholder rows
 *   tsx src/db/reanalyze-catalog.ts --all      # every image asset
 *   tsx src/db/reanalyze-catalog.ts --dry-run  # show what would change, no writes
 */

const FALLBACK_INSIGHT_MARK = 'Auto-tagging is temporarily unavailable';

async function main(): Promise<void> {
  const all = process.argv.includes('--all');
  const dryRun = process.argv.includes('--dry-run');

  const rows = await db
    .select()
    .from(assets)
    .where(sql`${assets.type} = 'PHOTO' OR ${assets.type} = 'GRAPHIC'`);

  // Target either every image, or just the ones that look un-analysed.
  const targets = rows.filter((r) => {
    if (!r.src) return false;
    if (all) return true;
    const insight = r.aiInsight ?? '';
    return insight === '' || insight.includes(FALLBACK_INSIGHT_MARK);
  });

  if (targets.length === 0) {
    console.log('✓ Nothing to re-analyse (no matching assets)');
    process.exit(0);
  }

  console.log(
    `▶ Re-analysing ${targets.length} asset(s)${all ? ' (--all)' : ''}${dryRun ? ' [dry-run]' : ''}…`,
  );

  let done = 0;
  const startedAt = Date.now();

  for (const row of targets) {
    try {
      const res = await fetch(row.src!);
      if (!res.ok) {
        console.warn(`  ⚠ ${row.id}: fetch ${res.status}, skipping`);
        continue;
      }
      const mimeType = res.headers.get('content-type') ?? 'image/jpeg';
      const buffer = Buffer.from(await res.arrayBuffer());

      const analysis = await tagAndDescribeImage(buffer, mimeType, row.title);

      console.log(
        `  · ${row.displayTitle}\n      tags: ${analysis.tags.join(', ')}\n      mood: ${analysis.dominantMood}`,
      );

      if (dryRun) {
        done++;
        continue;
      }

      const corpus = embeddingCorpus({
        displayTitle: row.displayTitle,
        tags: analysis.tags,
        aiInsight: analysis.insight,
        ownerLabel: row.ownerLabel,
      });
      const vec = await embedText(corpus, 'document');

      await db
        .update(assets)
        .set({
          tags: analysis.tags,
          aiInsight: analysis.insight,
          ...(vec.length > 0 ? { embedding: vec } : {}),
        })
        .where(eq(assets.id, row.id));
      done++;
    } catch (err) {
      console.warn(`  ⚠ ${row.id} failed:`, err);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `✓ ${dryRun ? 'Previewed' : 'Re-analysed'} ${done}/${targets.length} in ${elapsed}s`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ Re-analyse failed:', err);
  process.exit(1);
});
