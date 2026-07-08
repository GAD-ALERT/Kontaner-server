import { Router } from 'express';
import multer from 'multer';
import { db } from '../db/client.js';
import { assets, users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
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

export const uploadsRouter = Router();

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

  // 1. Cloudinary
  emit?.('status', { stage: 'uploading' });
  const uploaded = await uploadBufferToCloudinary(file.buffer, {
    folder: 'kontaner/uploads',
    publicId: assetId,
    resourceType: file.mimetype.startsWith('video/') ? 'video' : 'image',
  });
  emit?.('status', { stage: 'uploaded', url: uploaded.url });

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
    let uploadedPublicId: string | null = null;
    try {
      if (!req.file) throw badRequest('No file uploaded', 'NO_FILE');
      if (!ACCEPTED_MIMES.has(req.file.mimetype)) {
        throw badRequest('Unsupported file type', 'BAD_MIME');
      }
      const result = await runUploadPipeline(req.user!.sub, req.file);
      uploadedPublicId = null; // pipeline succeeded — nothing to roll back
      res.status(201).json(result);
    } catch (err) {
      if (uploadedPublicId) await safeDeleteCloudinary(uploadedPublicId);
      next(err);
    }
  },
);

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
