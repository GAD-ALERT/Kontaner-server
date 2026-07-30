import { Router } from 'express';
import multer from 'multer';
import { db } from '../db/client.js';
import { assets, users } from '../db/schema.js';
import { desc, eq, sql } from 'drizzle-orm';
import { requireAuth } from '../auth/middleware.js';
import { badRequest, HttpError } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { toPublicAsset } from '../lib/asset-mapper.js';
import {
  safeDeleteCloudinary,
  uploadBufferToCloudinary,
} from '../lib/cloudinary.js';
import { embedText, tagAndDescribeImage } from '../lib/gemini.js';
import { embeddingCorpus } from '../lib/search.js';
import { z } from 'zod';
import { forbidden, notFound } from '../lib/http.js';

export const uploadsRouter = Router();

/* GET /api/uploads — assets owned by the current user */
uploadsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(assets)
      .where(eq(assets.ownerId, req.user!.sub))
      .orderBy(desc(assets.createdAt));
    res.json({ items: rows.map(toPublicAsset) });
  } catch (err) {
    next(err);
  }
});

uploadsRouter.get('/usage', requireAuth, async (req, res, next) => {
  try {
    const [totals, breakdown, [user]] = await Promise.all([
      db.select({
        bytes: sql<string>`coalesce(sum(${assets.sizeBytes}), 0)::bigint`,
        count: sql<number>`count(*)::int`,
      }).from(assets).where(eq(assets.ownerId, req.user!.sub)),
      db.select({
        type: assets.type,
        bytes: sql<string>`coalesce(sum(${assets.sizeBytes}), 0)::bigint`,
        count: sql<number>`count(*)::int`,
      }).from(assets).where(eq(assets.ownerId, req.user!.sub)).groupBy(assets.type),
      db.select({ quotaBytes: users.storageQuotaBytes }).from(users).where(eq(users.id, req.user!.sub)).limit(1),
    ]);
    if (!user) throw notFound('Account not found');
    const usedBytes = Number(totals[0]?.bytes ?? 0);
    res.json({
      usedBytes,
      quotaBytes: user.quotaBytes,
      remainingBytes: Math.max(0, user.quotaBytes - usedBytes),
      assetCount: totals[0]?.count ?? 0,
      breakdown: breakdown.map((row) => ({ type: row.type, bytes: Number(row.bytes), count: row.count })),
    });
  } catch (err) { next(err); }
});

/** Cap uploads at 25 MB — Cloudinary free tier limit for anonymous plans. */
const MAX_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

const ACCEPTED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/heic',
  'image/heif',
]);

/* =========================================================
   Helper — one shared pipeline for both POST /uploads and
   POST /uploads/stream. Runs upload → Gemini → DB insert,
   with best-effort Cloudinary cleanup on failure.
   ========================================================= */

interface PipelineResult {
  asset: ReturnType<typeof toPublicAsset>;
  tags: string[];
  insight: string;
}

async function runUploadPipeline(
  userId: string,
  file: Express.Multer.File,
  emit?: (evt: string, data: unknown) => void,
): Promise<PipelineResult> {
  const assetId = newId('asset', 8);

  const [[account], [usage]] = await Promise.all([
    db.select({ quotaBytes: users.storageQuotaBytes }).from(users).where(eq(users.id, userId)).limit(1),
    db.select({ bytes: sql<string>`coalesce(sum(${assets.sizeBytes}), 0)::bigint` })
      .from(assets).where(eq(assets.ownerId, userId)),
  ]);
  if (!account) throw new HttpError(401, 'Account no longer exists', 'UNAUTHORIZED');
  const usedBytes = Number(usage?.bytes ?? 0);
  if (usedBytes + file.size > account.quotaBytes) {
    throw new HttpError(413, 'This upload would exceed your storage quota', 'STORAGE_QUOTA_EXCEEDED');
  }

  // 1. Cloudinary
  emit?.('status', { stage: 'uploading' });
  const uploaded = await uploadBufferToCloudinary(file.buffer, {
    folder: 'kontaner/uploads',
    publicId: assetId,
    resourceType: file.mimetype.startsWith('video/') ? 'video' : 'image',
  });
  emit?.('status', { stage: 'uploaded', url: uploaded.url });

  // Everything past the upload can fail (Gemini, DB). If it does, the
  // Cloudinary object is already live — roll it back so we don't orphan it.
  try {
    return await finishUploadPipeline(userId, file, assetId, uploaded, emit);
  } catch (err) {
    await safeDeleteCloudinary(uploaded.publicId);
    throw err;
  }
}

async function finishUploadPipeline(
  userId: string,
  file: Express.Multer.File,
  assetId: string,
  uploaded: Awaited<ReturnType<typeof uploadBufferToCloudinary>>,
  emit?: (evt: string, data: unknown) => void,
): Promise<PipelineResult> {
  // 2. Gemini tagging
  emit?.('status', { stage: 'analyzing' });
  const originalName = file.originalname || 'Untitled';
  const analysis = await tagAndDescribeImage(
    file.buffer,
    file.mimetype,
    originalName,
  );

  // Stream each tag one by one for the frontend's typewriter animation
  for (const tag of analysis.tags) {
    emit?.('tag', { tag });
  }
  emit?.('insight', { insight: analysis.insight });

  // 3. Persist asset row (embedding filled in step 4)
  const [ownerUser] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const ownerLabel = ownerUser?.name ?? 'You';
  const displayTitle = prettifyTitle(originalName);

  const [inserted] = await db
    .insert(assets)
    .values({
      id: assetId,
      ownerId: userId,
      title: originalName,
      displayTitle,
      ownerLabel,
      type: file.mimetype.startsWith('video/') ? 'VIDEO' : 'PHOTO',
      format: fmtFromMime(file.mimetype),
      sizeLabel: formatBytes(uploaded.bytes),
      sizeBytes: uploaded.bytes,
      date: new Date().toLocaleDateString('en-GB', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
      }),
      visual: pickVisual(assetId),
      src: uploaded.url,
      cloudinaryPublicId: uploaded.publicId,
      tags: analysis.tags,
      aiInsight: analysis.insight,
      likes: 0,
      downloads: 0,
      premium: false,
    })
    .returning();

  // 4. Embed for NL search — best-effort, never blocks the response
  //    (search can still fall back to text ILIKE if this fails)
  emit?.('status', { stage: 'indexing' });
  try {
    const corpus = embeddingCorpus({
      displayTitle,
      tags: analysis.tags,
      aiInsight: analysis.insight,
      ownerLabel,
    });
    const vec = await embedText(corpus);
    if (vec.length > 0) {
      await db
        .update(assets)
        .set({ embedding: vec })
        .where(eq(assets.id, assetId));
    }
  } catch (err) {
    console.warn('[uploads] embedding failed, will be backfilled later:', err);
  }

  emit?.('done', {
    asset: toPublicAsset(inserted),
    tags: analysis.tags,
    insight: analysis.insight,
  });

  return {
    asset: toPublicAsset(inserted),
    tags: analysis.tags,
    insight: analysis.insight,
  };
}

/* =========================================================
   POST /api/uploads
   Plain JSON response — the client waits for the full pipeline.
   ========================================================= */
uploadsRouter.post(
  '/',
  requireAuth,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) throw badRequest('No file uploaded', 'NO_FILE');
      if (!ACCEPTED_MIMES.has(req.file.mimetype)) {
        throw badRequest('Unsupported file type', 'BAD_MIME');
      }
      // Cloudinary rollback on partial failure is handled inside the pipeline.
      const result = await runUploadPipeline(req.user!.sub, req.file);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

const updateUploadSchema = z.object({
  displayTitle: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
  aiInsight: z.string().trim().max(2000).nullable().optional(),
  premium: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

/* PATCH /api/uploads/:id — update metadata for an owned asset */
uploadsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '');
    const parsed = updateUploadSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');

    const [existing] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
    if (!existing) throw notFound('Asset not found');
    if (existing.ownerId !== req.user!.sub) throw forbidden('You do not own this asset');

    const [updated] = await db.update(assets).set(parsed.data).where(eq(assets.id, id)).returning();
    res.json({ asset: toPublicAsset(updated) });
  } catch (err) {
    next(err);
  }
});

/* DELETE /api/uploads/:id — delete an owned asset and its Cloudinary object */
uploadsRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '');
    const [existing] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
    if (!existing) throw notFound('Asset not found');
    if (existing.ownerId !== req.user!.sub) throw forbidden('You do not own this asset');

    await db.delete(assets).where(eq(assets.id, id));
    if (existing.cloudinaryPublicId) await safeDeleteCloudinary(existing.cloudinaryPublicId);
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   POST /api/uploads/stream
   Server-Sent Events — emits status/tag/insight/done events so
   the frontend's typewriter tag animation stays alive with real
   Gemini output instead of the fake pre-baked pool.
   ========================================================= */
uploadsRouter.post(
  '/stream',
  requireAuth,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) throw badRequest('No file uploaded', 'NO_FILE');
      if (!ACCEPTED_MIMES.has(req.file.mimetype)) {
        throw badRequest('Unsupported file type', 'BAD_MIME');
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const emit = (event: string, data: unknown): void => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        await runUploadPipeline(req.user!.sub, req.file, emit);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        emit('error', {
          status,
          message: err instanceof Error ? err.message : 'Upload failed',
        });
      } finally {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  },
);

/* =========================================================
   Helpers
   ========================================================= */

function fmtFromMime(mime: string): string {
  if (mime === 'image/jpeg') return 'JPG';
  if (mime === 'image/png') return 'PNG';
  if (mime === 'image/webp') return 'WEBP';
  if (mime === 'image/tiff') return 'TIFF';
  if (mime === 'image/heic' || mime === 'image/heif') return 'HEIC';
  if (mime.startsWith('video/')) return 'MP4';
  return 'FILE';
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const VISUAL_POOL = [
  'visual-kente',
  'visual-market',
  'visual-portrait',
  'visual-village',
  'visual-textile',
  'visual-city',
  'visual-palms',
  'visual-illustration',
  'visual-baskets',
  'visual-gold',
  'visual-studio',
  'visual-architecture',
];

function pickVisual(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return VISUAL_POOL[Math.abs(h) % VISUAL_POOL.length]!;
}

function prettifyTitle(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[_\-]+/g, ' ');
}
