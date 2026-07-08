import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { assets, favorites } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { badRequest, notFound } from '../lib/http.js';
import { toPublicAsset } from '../lib/asset-mapper.js';

export const favoritesRouter = Router();

/* GET /api/favorites — full list, most-recently-saved first */
favoritesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await db
      .select({
        asset: assets,
        savedAt: favorites.createdAt,
      })
      .from(favorites)
      .innerJoin(assets, eq(favorites.assetId, assets.id))
      .where(eq(favorites.userId, req.user!.sub))
      .orderBy(desc(favorites.createdAt));

    res.json({
      items: rows.map((r) => ({
        ...toPublicAsset(r.asset),
        savedAt: r.savedAt,
      })),
      ids: rows.map((r) => r.asset.id),
    });
  } catch (err) {
    next(err);
  }
});

/* GET /api/favorites/ids — lightweight id list for store hydration */
favoritesRouter.get('/ids', requireAuth, async (req, res, next) => {
  try {
    const rows = await db
      .select({ assetId: favorites.assetId })
      .from(favorites)
      .where(eq(favorites.userId, req.user!.sub));
    res.json({ ids: rows.map((r) => r.assetId) });
  } catch (err) {
    next(err);
  }
});

/* POST /api/favorites/:assetId — toggle (idempotent) */
favoritesRouter.post('/:assetId', requireAuth, async (req, res, next) => {
  try {
    const assetId = String(req.params.assetId ?? '');
    if (!assetId) throw badRequest('Missing asset id');

    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);
    if (!asset) throw notFound('Asset not found');

    const [existing] = await db
      .select()
      .from(favorites)
      .where(
        and(eq(favorites.userId, req.user!.sub), eq(favorites.assetId, assetId)),
      )
      .limit(1);

    if (existing) {
      await db
        .delete(favorites)
        .where(
          and(
            eq(favorites.userId, req.user!.sub),
            eq(favorites.assetId, assetId),
          ),
        );
      res.json({ favorited: false, assetId });
    } else {
      await db
        .insert(favorites)
        .values({ userId: req.user!.sub, assetId })
        .onConflictDoNothing();
      res.json({ favorited: true, assetId });
    }
  } catch (err) {
    next(err);
  }
});

/* DELETE /api/favorites/:assetId — explicit remove */
favoritesRouter.delete('/:assetId', requireAuth, async (req, res, next) => {
  try {
    const assetId = String(req.params.assetId ?? '');
    if (!assetId) throw badRequest('Missing asset id');
    await db
      .delete(favorites)
      .where(
        and(
          eq(favorites.userId, req.user!.sub),
          eq(favorites.assetId, assetId),
        ),
      );
    res.json({ favorited: false, assetId });
  } catch (err) {
    next(err);
  }
});

/* POST /api/favorites/batch — bulk hydrate on login */
favoritesRouter.post('/batch', requireAuth, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
    if (ids.length === 0) return res.json({ ids: [] });
    const validIds = await db
      .select({ id: assets.id })
      .from(assets)
      .where(inArray(assets.id, ids));

    const rows = validIds.map(({ id }) => ({
      userId: req.user!.sub,
      assetId: id,
    }));
    if (rows.length > 0) {
      await db.insert(favorites).values(rows).onConflictDoNothing();
    }
    res.json({ ids: rows.map((r) => r.assetId) });
  } catch (err) {
    next(err);
  }
});
