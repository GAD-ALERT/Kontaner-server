import { Router } from 'express';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { assets, users } from '../db/schema.js';
import { notFound } from '../lib/http.js';
import { toPublicAsset } from '../lib/asset-mapper.js';

export const creatorsRouter = Router();

const publicCreator = (user: typeof users.$inferSelect, assetCount: number) => ({
  id: user.id,
  name: user.name,
  role: user.role,
  bio: user.bio ?? '',
  location: user.location ?? '',
  avatarUrl: user.avatarUrl ?? '',
  avatarInitials: user.avatarInitials,
  memberSince: user.createdAt,
  assetCount,
});

creatorsRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await db.select({
      user: users,
      assetCount: sql<number>`count(${assets.id})::int`,
    }).from(users).innerJoin(assets, eq(assets.ownerId, users.id))
      .groupBy(users.id).orderBy(desc(sql`count(${assets.id})`)).limit(24);
    res.json({ items: rows.map((row) => publicCreator(row.user, row.assetCount)) });
  } catch (err) { next(err); }
});

creatorsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '');
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) throw notFound('Creator not found');
    const creatorAssets = await db.select().from(assets).where(eq(assets.ownerId, id)).orderBy(desc(assets.createdAt));
    res.json({
      creator: publicCreator(user, creatorAssets.length),
      items: creatorAssets.map(toPublicAsset),
    });
  } catch (err) { next(err); }
});
