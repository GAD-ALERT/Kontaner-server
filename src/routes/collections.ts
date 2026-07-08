import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  assets,
  collectionItems,
  collections,
  type CollectionRow,
} from '../db/schema.js';
import { attachUser, requireAuth } from '../auth/middleware.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { toPublicAsset } from '../lib/asset-mapper.js';

export const collectionsRouter = Router();

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).optional().default(''),
  visual: z
    .enum(['collection-kente', 'collection-tourism', 'collection-urban'])
    .optional(),
  isPublic: z.boolean().optional().default(false),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(2000).optional(),
  visual: z
    .enum(['collection-kente', 'collection-tourism', 'collection-urban'])
    .optional(),
  isPublic: z.boolean().optional(),
});

const visualPool = [
  'collection-kente',
  'collection-tourism',
  'collection-urban',
] as const;

function pickVisual(seed: string): (typeof visualPool)[number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return visualPool[Math.abs(h) % visualPool.length]!;
}

interface CollectionSummary {
  id: string;
  name: string;
  description: string;
  visual: string;
  isPublic: boolean;
  assetCount: number;
  updated: string;
  createdAt: number;
  assetIds: string[];
}

function summarise(
  row: CollectionRow,
  assetIds: string[] = [],
): CollectionSummary {
  const updatedAgo = relativeUpdated(row.updatedAt);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visual: row.visual,
    isPublic: row.isPublic,
    assetCount: assetIds.length,
    updated: updatedAgo,
    createdAt: row.createdAt.getTime(),
    assetIds,
  };
}

function relativeUpdated(d: Date): string {
  const diff = Date.now() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diff < 60 * 1000) return 'Modified just now';
  if (diff < 60 * 60 * 1000) return `Modified ${Math.floor(diff / (60 * 1000))} min ago`;
  if (diff < day) return `Modified ${Math.floor(diff / (60 * 60 * 1000))} hr ago`;
  if (diff < 7 * day) return `Modified ${Math.floor(diff / day)} day${Math.floor(diff / day) === 1 ? '' : 's'} ago`;
  return `Modified ${d.toLocaleDateString('en-GB', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  })}`;
}

async function loadCollectionsWithIds(
  userId: string,
): Promise<CollectionSummary[]> {
  const rows = await db
    .select()
    .from(collections)
    .where(eq(collections.ownerId, userId))
    .orderBy(desc(collections.createdAt));

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const items = await db
    .select({
      collectionId: collectionItems.collectionId,
      assetId: collectionItems.assetId,
    })
    .from(collectionItems)
    .where(inArray(collectionItems.collectionId, ids));

  const grouped = new Map<string, string[]>();
  for (const it of items) {
    const list = grouped.get(it.collectionId) ?? [];
    list.push(it.assetId);
    grouped.set(it.collectionId, list);
  }
  return rows.map((r) => summarise(r, grouped.get(r.id) ?? []));
}

/* ================================================================
   GET /api/collections
   Owner-scoped list. Requires auth.
   ================================================================ */
collectionsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const items = await loadCollectionsWithIds(req.user!.sub);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/* ================================================================
   POST /api/collections
   ================================================================ */
collectionsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');
    }
    const { name, description, visual, isPublic } = parsed.data;
    const id = newId('col', 6);
    const [inserted] = await db
      .insert(collections)
      .values({
        id,
        ownerId: req.user!.sub,
        name,
        description,
        visual: visual ?? pickVisual(id),
        isPublic,
      })
      .returning();
    res.status(201).json({ collection: summarise(inserted, []) });
  } catch (err) {
    next(err);
  }
});

/* ================================================================
   GET /api/collections/:id
   Public collections are readable by anyone. Private only by owner.
   ================================================================ */
collectionsRouter.get('/:id', attachUser, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '');
    if (!id) throw notFound('Collection not found');
    const [row] = await db
      .select()
      .from(collections)
      .where(eq(collections.id, id))
      .limit(1);
    if (!row) throw notFound('Collection not found');
    if (!row.isPublic && req.user?.sub !== row.ownerId) {
      throw forbidden('This collection is private');
    }

    const itemsRows = await db
      .select({ asset: assets })
      .from(collectionItems)
      .innerJoin(assets, eq(collectionItems.assetId, assets.id))
      .where(eq(collectionItems.collectionId, id))
      .orderBy(desc(collectionItems.createdAt));

    const items = itemsRows.map((r) => toPublicAsset(r.asset));
    res.json({
      collection: summarise(
        row,
        items.map((a) => a.id),
      ),
      items,
    });
  } catch (err) {
    next(err);
  }
});

/* ================================================================
   PATCH /api/collections/:id
   ================================================================ */
collectionsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '');
    if (!id) throw notFound('Collection not found');
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');
    }

    const [existing] = await db
      .select()
      .from(collections)
      .where(eq(collections.id, id))
      .limit(1);
    if (!existing) throw notFound('Collection not found');
    if (existing.ownerId !== req.user!.sub) throw forbidden();

    const [updated] = await db
      .update(collections)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(collections.id, id))
      .returning();

    const assetIds = await db
      .select({ id: collectionItems.assetId })
      .from(collectionItems)
      .where(eq(collectionItems.collectionId, id));

    res.json({
      collection: summarise(
        updated,
        assetIds.map((a) => a.id),
      ),
    });
  } catch (err) {
    next(err);
  }
});

/* ================================================================
   DELETE /api/collections/:id
   ================================================================ */
collectionsRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '');
    if (!id) throw notFound('Collection not found');
    const [existing] = await db
      .select({ ownerId: collections.ownerId })
      .from(collections)
      .where(eq(collections.id, id))
      .limit(1);
    if (!existing) throw notFound('Collection not found');
    if (existing.ownerId !== req.user!.sub) throw forbidden();

    await db.delete(collections).where(eq(collections.id, id));
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

/* ================================================================
   POST /api/collections/:id/items/:assetId   — toggle
   ================================================================ */
collectionsRouter.post(
  '/:id/items/:assetId',
  requireAuth,
  async (req, res, next) => {
    try {
      const id = String(req.params.id ?? '');
      const assetId = String(req.params.assetId ?? '');
      if (!id || !assetId) throw badRequest('Missing id');

      const [col] = await db
        .select({ ownerId: collections.ownerId })
        .from(collections)
        .where(eq(collections.id, id))
        .limit(1);
      if (!col) throw notFound('Collection not found');
      if (col.ownerId !== req.user!.sub) throw forbidden();

      const [assetExists] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.id, assetId))
        .limit(1);
      if (!assetExists) throw notFound('Asset not found');

      const [existing] = await db
        .select()
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionId, id),
            eq(collectionItems.assetId, assetId),
          ),
        )
        .limit(1);

      let action: 'added' | 'removed';
      if (existing) {
        await db
          .delete(collectionItems)
          .where(
            and(
              eq(collectionItems.collectionId, id),
              eq(collectionItems.assetId, assetId),
            ),
          );
        action = 'removed';
      } else {
        await db
          .insert(collectionItems)
          .values({ collectionId: id, assetId })
          .onConflictDoNothing();
        action = 'added';
      }

      await db
        .update(collections)
        .set({ updatedAt: new Date() })
        .where(eq(collections.id, id));

      const total = await db
        .select({ id: collectionItems.assetId })
        .from(collectionItems)
        .where(eq(collectionItems.collectionId, id));

      res.json({ action, assetId, assetCount: total.length });
    } catch (err) {
      next(err);
    }
  },
);
