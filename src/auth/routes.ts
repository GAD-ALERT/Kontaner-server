import { Router } from 'express';
import bcrypt from 'bcrypt';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import multer from 'multer';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db/client.js';
import { passwordResetTokens, users } from '../db/schema.js';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, HttpError, unauthorized } from '../lib/http.js';
import { requireAuth, signToken } from './middleware.js';
import { sendPasswordResetEmail } from '../lib/email.js';
import { safeDeleteCloudinary, uploadBufferToCloudinary } from '../lib/cloudinary.js';

export const authRouter = Router();

const signupSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120),
  role: z.string().max(60).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

const forgotSchema = z.object({ email: z.string().email().max(254) });
const resetSchema = z.object({ token: z.string().min(32).max(300), password: z.string().min(8).max(200) });
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const AVATAR_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const hashResetToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const profilePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.string().max(60).optional(),
  bio: z.string().max(2000).optional(),
  location: z.string().max(120).optional(),
  avatarUrl: z.string().url().max(1000).optional(),
});
const preferencesSchema = z.object({
  digest: z.boolean(), activity: z.boolean(), promotions: z.boolean(), security: z.boolean(),
});

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return 'KT';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function toPublicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    bio: u.bio ?? '',
    location: u.location ?? '',
    avatarUrl: u.avatarUrl ?? '',
    avatarInitials: u.avatarInitials,
    createdAt: u.createdAt,
    notificationPreferences: u.notificationPreferences,
  };
}

/* POST /auth/signup */
authRouter.post('/signup', async (req, res, next) => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');
    }
    const { email, password, name, role } = parsed.data;
    const emailLower = email.toLowerCase();

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${emailLower}`)
      .limit(1);
    if (existing.length > 0) {
      throw conflict('An account with that email already exists', 'EMAIL_TAKEN');
    }

    const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
    const id = newId('usr');
    const [inserted] = await db
      .insert(users)
      .values({
        id,
        email: emailLower,
        passwordHash,
        name,
        role: role ?? 'Visual Designer',
        avatarInitials: initialsFromName(name),
      })
      .returning();

    const token = signToken({ sub: inserted.id, email: inserted.email });
    res.status(201).json({ token, user: toPublicUser(inserted) });
  } catch (err) {
    next(err);
  }
});

/* POST /auth/login */
authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');
    }
    const { email, password } = parsed.data;
    const emailLower = email.toLowerCase();

    const [user] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${emailLower}`)
      .limit(1);
    if (!user) throw unauthorized('Invalid email or password');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw unauthorized('Invalid email or password');

    const token = signToken({ sub: user.id, email: user.email });
    res.json({ token, user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/forgot-password', async (req, res, next) => {
  let resetId: string | null = null;
  try {
    if (!env.GMAIL_SMTP_USER || !env.GMAIL_SMTP_APP_PASSWORD) {
      throw new HttpError(503, 'Password recovery email is not configured', 'EMAIL_NOT_CONFIGURED');
    }
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid email');
    const email = parsed.data.email.toLowerCase();
    const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
    if (user) {
      const token = randomBytes(32).toString('base64url');
      resetId = newId('reset', 8);
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
      await db.insert(passwordResetTokens).values({
        id: resetId,
        userId: user.id,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      await sendPasswordResetEmail(user.email, token);
    }
    res.json({ ok: true });
  } catch (err) {
    if (resetId) await db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, resetId));
    next(err);
  }
});

authRouter.post('/reset-password', async (req, res, next) => {
  try {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid reset request');
    const [reset] = await db.select().from(passwordResetTokens).where(and(
      eq(passwordResetTokens.tokenHash, hashResetToken(parsed.data.token)),
      isNull(passwordResetTokens.usedAt),
    )).limit(1);
    if (!reset || reset.expiresAt.getTime() <= Date.now()) {
      throw badRequest('This reset link is invalid or has expired', 'RESET_TOKEN_INVALID');
    }
    const passwordHash = await bcrypt.hash(parsed.data.password, env.BCRYPT_ROUNDS);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, reset.userId));
      await tx.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, reset.id));
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res, next) => {
  let uploadedPublicId: string | null = null;
  try {
    if (!req.file) throw badRequest('No avatar uploaded', 'NO_FILE');
    if (!AVATAR_MIMES.has(req.file.mimetype)) throw badRequest('Avatar must be JPG, PNG, or WEBP', 'BAD_MIME');
    const [existing] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    if (!existing) throw unauthorized('Account no longer exists');
    const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
      folder: 'kontaner/avatars', publicId: `${req.user!.sub}-${newId('avatar', 4)}`, resourceType: 'image',
    });
    uploadedPublicId = uploaded.publicId;
    const [updated] = await db.update(users).set({
      avatarUrl: uploaded.url, avatarPublicId: uploaded.publicId, updatedAt: new Date(),
    }).where(eq(users.id, req.user!.sub)).returning();
    uploadedPublicId = null;
    if (existing.avatarPublicId && existing.avatarPublicId !== uploaded.publicId) {
      await safeDeleteCloudinary(existing.avatarPublicId);
    }
    res.json({ user: toPublicUser(updated) });
  } catch (err) {
    if (uploadedPublicId) await safeDeleteCloudinary(uploadedPublicId);
    next(err);
  }
});

/* GET /me — current user profile */
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.user!.sub))
      .limit(1);
    if (!user) throw unauthorized('Account no longer exists');
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

/* PATCH /me — update profile fields */
authRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const parsed = profilePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');
    }
    const patch = parsed.data;
    const nextInitials = patch.name ? initialsFromName(patch.name) : undefined;

    const [updated] = await db
      .update(users)
      .set({
        ...patch,
        ...(nextInitials ? { avatarInitials: nextInitials } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, req.user!.sub))
      .returning();

    res.json({ user: toPublicUser(updated) });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me/preferences', requireAuth, async (req, res, next) => {
  try {
    const [user] = await db.select({ preferences: users.notificationPreferences })
      .from(users).where(eq(users.id, req.user!.sub)).limit(1);
    if (!user) throw unauthorized('Account no longer exists');
    res.json({ preferences: user.preferences });
  } catch (err) { next(err); }
});

authRouter.put('/me/preferences', requireAuth, async (req, res, next) => {
  try {
    const parsed = preferencesSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid preferences');
    const [updated] = await db.update(users).set({
      notificationPreferences: parsed.data, updatedAt: new Date(),
    }).where(eq(users.id, req.user!.sub)).returning({ preferences: users.notificationPreferences });
    if (!updated) throw unauthorized('Account no longer exists');
    res.json({ preferences: updated.preferences });
  } catch (err) { next(err); }
});

/* POST /auth/logout — client just drops the token; endpoint exists
   for symmetry and future refresh-token invalidation. */
authRouter.post('/logout', requireAuth, (_req, res) => {
  res.json({ ok: true });
});
