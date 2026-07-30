import {
  boolean,
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export interface NotificationPreferences {
  digest: boolean;
  activity: boolean;
  promotions: boolean;
  security: boolean;
}

/* =============================================================
   users
   ============================================================= */
export const users = pgTable(
  'users',
  {
    id: varchar('id', { length: 32 }).primaryKey(),
    email: varchar('email', { length: 254 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    role: varchar('role', { length: 60 }).default('Visual Designer').notNull(),
    bio: text('bio'),
    location: varchar('location', { length: 120 }),
    avatarUrl: text('avatar_url'),
    avatarPublicId: text('avatar_public_id'),
    avatarInitials: varchar('avatar_initials', { length: 4 }).notNull(),
    notificationPreferences: jsonb('notification_preferences').$type<NotificationPreferences>()
      .default({ digest: true, activity: true, promotions: false, security: true }).notNull(),
    storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' })
      .default(20 * 1024 * 1024 * 1024).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_lower_unique').on(sql`lower(${t.email})`),
  }),
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: varchar('id', { length: 48 }).primaryKey(),
    userId: varchar('user_id', { length: 32 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('password_reset_tokens_hash_unique').on(t.tokenHash),
    userIdx: index('password_reset_tokens_user_idx').on(t.userId),
  }),
);

/* =============================================================
   assets
   Owner is nullable — seeded catalogue assets belong to the
   platform, not a specific user.
   ============================================================= */
export const assets = pgTable(
  'assets',
  {
    id: varchar('id', { length: 48 }).primaryKey(),
    ownerId: varchar('owner_id', { length: 32 }).references(() => users.id, {
      onDelete: 'set null',
    }),

    title: varchar('title', { length: 200 }).notNull(),
    displayTitle: varchar('display_title', { length: 200 }).notNull(),
    ownerLabel: varchar('owner_label', { length: 160 }).notNull(),

    type: varchar('type', { length: 12 }).notNull(),       // PHOTO | VIDEO | GRAPHIC | 3D
    format: varchar('format', { length: 12 }).notNull(),   // JPG | PNG | ...
    sizeLabel: varchar('size_label', { length: 32 }).notNull(),
    sizeBytes: integer('size_bytes'),
    date: varchar('date', { length: 32 }).notNull(),

    visual: varchar('visual', { length: 40 }).notNull(),
    src: text('src'),
    cloudinaryPublicId: text('cloudinary_public_id'),

    tags: jsonb('tags').$type<string[]>().default([]).notNull(),
    aiInsight: text('ai_insight'),
    embedding: jsonb('embedding').$type<number[] | null>(),

    likes: integer('likes').default(0).notNull(),
    downloads: integer('downloads').default(0).notNull(),
    premium: boolean('premium').default(false).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    typeIdx: index('assets_type_idx').on(t.type),
    ownerIdx: index('assets_owner_idx').on(t.ownerId),
  }),
);

/* =============================================================
   favorites (user ↔ asset, many-to-many)
   ============================================================= */
export const favorites = pgTable(
  'favorites',
  {
    userId: varchar('user_id', { length: 32 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetId: varchar('asset_id', { length: 48 })
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.assetId] }),
  }),
);

/* =============================================================
   collections
   ============================================================= */
export const collections = pgTable(
  'collections',
  {
    id: varchar('id', { length: 48 }).primaryKey(),
    ownerId: varchar('owner_id', { length: 32 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 160 }).notNull(),
    description: text('description').default('').notNull(),
    visual: varchar('visual', { length: 40 }).notNull(),
    isPublic: boolean('is_public').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ownerIdx: index('collections_owner_idx').on(t.ownerId),
  }),
);

export const collectionItems = pgTable(
  'collection_items',
  {
    collectionId: varchar('collection_id', { length: 48 })
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    assetId: varchar('asset_id', { length: 48 })
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.collectionId, t.assetId] }),
  }),
);

/* =============================================================
   downloads
   ============================================================= */
export const downloads = pgTable(
  'downloads',
  {
    id: varchar('id', { length: 48 }).primaryKey(),
    userId: varchar('user_id', { length: 32 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetId: varchar('asset_id', { length: 48 })
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    downloadedAt: timestamp('downloaded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('downloads_user_idx').on(t.userId),
  }),
);

/* =============================================================
   notifications
   ============================================================= */
export const notifications = pgTable(
  'notifications',
  {
    id: varchar('id', { length: 48 }).primaryKey(),
    userId: varchar('user_id', { length: 32 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tone: varchar('tone', { length: 24 }).notNull(),      // system | collection | social | security
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').default('').notNull(),
    href: text('href'),
    read: boolean('read').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('notifications_user_idx').on(t.userId),
  }),
);

/* =============================================================
   Relations (for typed queries)
   ============================================================= */
export const usersRelations = relations(users, ({ many }) => ({
  assets: many(assets),
  favorites: many(favorites),
  collections: many(collections),
  downloads: many(downloads),
  notifications: many(notifications),
}));

export const assetsRelations = relations(assets, ({ one, many }) => ({
  owner: one(users, { fields: [assets.ownerId], references: [users.id] }),
  favorites: many(favorites),
  collectionItems: many(collectionItems),
}));

export const favoritesRelations = relations(favorites, ({ one }) => ({
  user: one(users, { fields: [favorites.userId], references: [users.id] }),
  asset: one(assets, { fields: [favorites.assetId], references: [assets.id] }),
}));

export const collectionsRelations = relations(collections, ({ one, many }) => ({
  owner: one(users, { fields: [collections.ownerId], references: [users.id] }),
  items: many(collectionItems),
}));

export const collectionItemsRelations = relations(collectionItems, ({ one }) => ({
  collection: one(collections, {
    fields: [collectionItems.collectionId],
    references: [collections.id],
  }),
  asset: one(assets, {
    fields: [collectionItems.assetId],
    references: [assets.id],
  }),
}));

/* =============================================================
   Type helpers
   ============================================================= */
export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AssetRow = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type CollectionRow = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type NotificationRow = typeof notifications.$inferSelect;

/**
 * Real-world dominant colors are recomputed from the image at request time
 * via colorthief on the frontend, but the extracted swatches can be cached
 * here to avoid the CPU cost. We keep them in `assets.tags`-adjacent JSON
 * fields only if we later need them; for now the frontend still owns this.
 */
export const dominantColorNote =
  'Dominant colors stay client-side via colorthief; no backend column needed.';
