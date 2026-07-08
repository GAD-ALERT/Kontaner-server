import { Router } from 'express';
import bcrypt from 'bcrypt';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, unauthorized } from '../lib/http.js';
import { requireAuth, signToken } from './middleware.js';

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

const profilePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.string().max(60).optional(),
  bio: z.string().max(2000).optional(),
  location: z.string().max(120).optional(),
  avatarUrl: z.string().url().max(1000).optional(),
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

/* POST /auth/logout — client just drops the token; endpoint exists
   for symmetry and future refresh-token invalidation. */
authRouter.post('/logout', requireAuth, (_req, res) => {
  res.json({ ok: true });
});
