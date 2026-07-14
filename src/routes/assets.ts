import { Router } from 'express';
import { and, desc, eq, ilike, ne, or, sql } from 'drizzle-orm';
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
  type: z.enum(['PHOTO', 'VIDEO', 'GRAPHIC', '3D']).optional(),
  tier: z.enum(['free', 'premium', 'all']).default('all'),
  sort: z.enum(['relevance', 'popular', 'new', 'trending']).default('relevance'),
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
    const { q, page, pageSize, mode, type, tier, sort } = parsed.data;
    const offset = (page - 1) * pageSize;
    const filters = [];
    if (type) filters.push(eq(assets.type, type));
    if (tier === 'free') filters.push(eq(assets.premium, false));
    if (tier === 'premium') filters.push(eq(assets.premium, true));

    const trySemantic = mode !== 'text';
    if (trySemantic) {
      try {
        const queryVec = await embedText(q);
        if (queryVec.length > 0) {
          const rows = await db
            .select()
            .from(assets)
            .where(and(sql`${assets.embedding} IS NOT NULL`, ...filters));

          let ranked = rankByEmbedding(
            rows.map((r) => ({ ...r, embedding: r.embedding ?? [] })),
            queryVec,
            { topK: 10000, minScore: 0.15 },
          );

          if (sort === 'popular') ranked = ranked.sort((a, b) => b.item.likes - a.item.likes);
          if (sort === 'trending') ranked = ranked.sort((a, b) => b.item.downloads - a.item.downloads);
          if (sort === 'new') ranked = ranked.sort((a, b) => b.item.createdAt.getTime() - a.item.createdAt.getTime());

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
    const textFilter = or(
      ilike(assets.title, like),
      ilike(assets.displayTitle, like),
      ilike(assets.ownerLabel, like),
      sql`${assets.tags}::text ILIKE ${like}`,
      sql`coalesce(${assets.aiInsight}, '') ILIKE ${like}`,
    );
    const where = and(textFilter, ...filters);
    const order = sort === 'new' ? desc(assets.createdAt)
      : sort === 'trending' ? desc(assets.downloads)
        : desc(assets.likes);
    const [rows, [{ count }]] = await Promise.all([db
      .select()
      .from(assets)
      .where(where)
      .orderBy(order)
      .limit(pageSize)
      .offset(offset), db.select({ count: sql<number>`count(*)::int` }).from(assets).where(where)]);

    res.json({
      items: rows.map(toPublicAsset),
      query: q,
      page,
      pageSize,
      total: Number(count),
      mode: 'text',
    });
  } catch (err) {
    next(err);
  }
});

assetsRouter.get('/:id/similar', attachUser, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '');
    const parsedLimit = z.coerce.number().int().min(1).max(12).default(4).safeParse(req.query.limit);
    if (!parsedLimit.success) throw badRequest('Similar asset limit must be between 1 and 12');
    const limit = parsedLimit.data;
    const [source] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
    if (!source) throw notFound('Asset not found');
    const candidates = await db.select().from(assets).where(and(ne(assets.id, id), eq(assets.type, source.type)));

    let ranked: Array<{ item: typeof source; score: number }>;
    if (source.embedding?.length) {
      ranked = rankByEmbedding(candidates, source.embedding, { topK: limit, minScore: 0 });
    } else {
      const sourceTags = new Set(source.tags.map((tag) => tag.toLowerCase()));
      ranked = candidates.map((item) => ({
        item,
        score: item.tags.reduce((score, tag) => score + (sourceTags.has(tag.toLowerCase()) ? 1 : 0), 0),
      })).sort((a, b) => b.score - a.score || b.item.likes - a.item.likes).slice(0, limit);
    }
    res.json({ items: ranked.map(({ item, score }) => ({ ...toPublicAsset(item), relevance: Number(score.toFixed(4)) })) });
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
