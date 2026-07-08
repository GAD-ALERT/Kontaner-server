import { db } from './client.js';
import { assets } from './schema.js';
import { seedAssets, seedImageUrl } from './seed-data.js';

/**
 * Insert seed assets if not already present.
 * Uses `onConflictDoNothing` so re-running is safe.
 */
async function main(): Promise<void> {
  const rows = seedAssets.map((a) => ({
    id: a.id,
    ownerId: null,
    title: a.title,
    displayTitle: a.displayTitle,
    ownerLabel: a.ownerLabel,
    type: a.type,
    format: a.format,
    sizeLabel: a.sizeLabel,
    date: a.date,
    visual: a.visual,
    src: seedImageUrl(a.id),
    tags: a.tags,
    likes: a.likes,
    downloads: a.downloads,
    premium: a.premium,
  }));

  console.log(`▶ Seeding ${rows.length} assets…`);
  const result = await db
    .insert(assets)
    .values(rows)
    .onConflictDoNothing({ target: assets.id })
    .returning({ id: assets.id });
  console.log(`✓ Inserted ${result.length} new (${rows.length - result.length} already existed)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ Seed failed:', err);
  process.exit(1);
});
