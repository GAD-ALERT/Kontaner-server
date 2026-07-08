import { Router } from 'express';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { assets } from '../db/schema.js';
import { attachUser } from '../auth/middleware.js';
import { badRequest, notFound } from '../lib/http.js';
import { toPublicAsset } from '../lib/asset-mapper.js';
import { embedText } from '../lib/gemini.js';
import { rankByEmbedding } from '../lib/search.js';

export const assetsRouter = Router();

const listQuerySchema = z.object({
  type: z.enum(['PHOTO', 'VIDEO', 'GRAPHIC', '3D']).optional(),
  tier: z.enum(['free', 'premium', 'all']).optional().default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
  sort: z.enum(['new', 'popular', 'trending']).optional().default('new'),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
  mode: z.enum(['auto', 'text', 'semantic']).default('auto'),
});

/* GET /api/assets — paginated browse feed */
assetsRouter.get('/', attachUser, async (req, res, next) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid filter');
    }
    const { type, tier, page, pageSize, sort } = parsed.data;

    const filters = [];
    if (type) filters.push(eq(assets.type, type));
    if (tier === 'free') filters.push(eq(assets.premium, false));
    if (tier === 'premium') filters.push(eq(assets.premium, true));

    const order =
      sort === 'popular'
        ? desc(assets.likes)
        : sort === 'trending'
          ? desc(assets.downloads)
          : desc(assets.createdAt);

    const offset = (page - 1) * pageSize;

    const [rows, [{ count }]] = await Promise.all([
      db
        .select()
        .from(assets)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(order)
        .limit(pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(assets)
        .where(filters.length > 0 ? and(...filters) : undefined),
    ]);

    res.json({
      items: rows.map(toPublicAsset),
      page,
      pageSize,
      total: Number(count),
      hasMore: offset + rows.length < Number(count),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/assets/search?q=…
 *
 * Semantic mode: embed the query with Gemini's text-embedding-004,
 * cosine-rank every asset whose embedding is populated, return top-K.
 * Text mode: fall back to case-insensitive LIKE across
 * title/displayTitle/owner/tags/aiInsight.
 *
 * `mode=auto` (default) tries semantic first and only falls back to
 * text if the embedding call fails or the DB has no embeddings yet.
 */
assetsRouter.get('/search', attachUser, async (req, res, next) => {
  try {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
    }
    const { q, page, pageSize, mode } = parsed.data;
    const offset = (page - 1) * pageSize;

    const trySemantic = mode !== 'text';
    if (trySemantic) {
      try {
        const queryVec = await embedText(q);
        if (queryVec.length > 0) {
          const rows = await db
            .select()
            .from(assets)
            .where(sql`${assets.embedding} IS NOT NULL`);

          const ranked = rankByEmbedding(
            rows.map((r) => ({ ...r, embedding: r.embedding ?? [] })),
            queryVec,
            { topK: pageSize + offset, minScore: 0.15 },
          );

          if (ranked.length > 0) {
            const paged = ranked.slice(offset, offset + pageSize);
            return res.json({
              items: paged.map(({ item, score }) => ({
                ...toPublicAsset(item),
                relevance: Number(score.toFixed(4)),
              })),
              query: q,
              page,
              pageSize,
              total: ranked.length,
              mode: 'semantic',
            });
          }
        }
      } catch (err) {
        console.warn('[search] semantic path failed, falling back to text:', err);
      }
      if (mode === 'semantic') {
        return res.json({
          items: [],
          query: q,
          page,
          pageSize,
          total: 0,
          mode: 'semantic',
        });
      }
    }

    // ── Text fallback ──
    const like = `%${q}%`;
    const rows = await db
      .select()
      .from(assets)
      .where(
        or(
          ilike(assets.title, like),
          ilike(assets.displayTitle, like),
          ilike(assets.ownerLabel, like),
          sql`${assets.tags}::text ILIKE ${like}`,
          sql`coalesce(${assets.aiInsight}, '') ILIKE ${like}`,
        ),
      )
      .orderBy(desc(assets.likes))
      .limit(pageSize)
      .offset(offset);

    res.json({
      items: rows.map(toPublicAsset),
      query: q,
      page,
      pageSize,
      total: rows.length,
      mode: 'text',
    });
  } catch (err) {
    next(err);
  }
});

/* GET /api/assets/:id */
assetsRouter.get('/:id', attachUser, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '');
    if (!id) throw notFound('Asset not found');
    const [row] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, id))
      .limit(1);
    if (!row) throw notFound('Asset not found');
    res.json({ asset: toPublicAsset(row) });
  } catch (err) {
    next(err);
  }
});
