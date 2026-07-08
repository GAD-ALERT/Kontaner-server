import { Router } from 'express';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { assets, downloads } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { notFound } from '../lib/http.js';
import { newId } from '../lib/ids.js';

export const downloadsRouter = Router();

/* GET /api/downloads — recent downloads for the current user */
downloadsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await db
      .select({
        assetId: downloads.assetId,
        downloadedAt: downloads.downloadedAt,
        asset: assets,
      })
      .from(downloads)
      .innerJoin(assets, eq(downloads.assetId, assets.id))
      .where(eq(downloads.userId, req.user!.sub))
      .orderBy(desc(downloads.downloadedAt))
      .limit(30);

    res.json({
      items: rows.map((r) => ({
        assetId: r.assetId,
        downloadedAt: r.downloadedAt.getTime(),
        title: r.asset.displayTitle,
        src: r.asset.src,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/downloads/:assetId
 *
 * Records the download and returns the direct URL. The frontend fetches the
 * URL itself (Cloudinary CDN handles auth-less streaming). We also increment
 * the asset's download counter as a bonus signal for the "trending" sort.
 */
downloadsRouter.post('/:assetId', requireAuth, async (req, res, next) => {
  try {
    const assetId = String(req.params.assetId ?? '');
    const [row] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);
    if (!row) throw notFound('Asset not found');

    await db.insert(downloads).values({
      id: newId('dl', 6),
      userId: req.user!.sub,
      assetId,
    });

    await db
      .update(assets)
      .set({ downloads: sql`${assets.downloads} + 1` })
      .where(eq(assets.id, assetId));

    res.json({
      ok: true,
      assetId,
      url: row.src,
      filename: row.title,
      size: row.sizeLabel,
    });
  } catch (err) {
    next(err);
  }
});
