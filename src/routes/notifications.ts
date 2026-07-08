import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { newId } from '../lib/ids.js';

export const notificationsRouter = Router();

const createSchema = z.object({
  tone: z.enum(['system', 'collection', 'social', 'security']),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(2000).optional().default(''),
  href: z.string().max(500).optional(),
});

/* GET /api/notifications */
notificationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, req.user!.sub))
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        tone: r.tone,
        title: r.title,
        body: r.body,
        href: r.href,
        read: r.read,
        createdAt: r.createdAt.getTime(),
      })),
      unread: rows.filter((r) => !r.read).length,
    });
  } catch (err) {
    next(err);
  }
});

/* POST /api/notifications — server-issued (backend routes push their own; this exists for parity with the frontend store) */
notificationsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid payload');
    }
    const id = newId('notif', 6);
    const [inserted] = await db
      .insert(notifications)
      .values({
        id,
        userId: req.user!.sub,
        ...parsed.data,
      })
      .returning();
    res.status(201).json({
      notification: {
        id: inserted.id,
        tone: inserted.tone,
        title: inserted.title,
        body: inserted.body,
        href: inserted.href,
        read: inserted.read,
        createdAt: inserted.createdAt.getTime(),
      },
    });
  } catch (err) {
    next(err);
  }
});

/* PATCH /api/notifications/:id — mark read/unread */
notificationsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '');
    if (!id) throw notFound('Notification not found');
    const read = req.body?.read === true;
    const [existing] = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(eq(notifications.id, id))
      .limit(1);
    if (!existing) throw notFound('Notification not found');
    if (existing.userId !== req.user!.sub) throw forbidden();

    await db
      .update(notifications)
      .set({ read })
      .where(eq(notifications.id, id));
    res.json({ ok: true, id, read });
  } catch (err) {
    next(err);
  }
});

/* POST /api/notifications/mark-all-read */
notificationsRouter.post('/mark-all-read', requireAuth, async (req, res, next) => {
  try {
    await db
      .update(notifications)
      .set({ read: true })
      .where(
        and(eq(notifications.userId, req.user!.sub), eq(notifications.read, false)),
      );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* DELETE /api/notifications/:id */
notificationsRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '');
    if (!id) throw notFound('Notification not found');
    const [existing] = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(eq(notifications.id, id))
      .limit(1);
    if (!existing) throw notFound('Notification not found');
    if (existing.userId !== req.user!.sub) throw forbidden();

    await db.delete(notifications).where(eq(notifications.id, id));
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});
