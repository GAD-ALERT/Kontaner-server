# Kontaner Backend

Express + TypeScript API for the Kontaner creative-asset library.
Powers auth, the asset catalogue, uploads, favorites, collections, and
the Gemini-backed AI features (tagging, insight, natural-language search).

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20 + Express + TypeScript (ESM) |
| ORM | [Drizzle](https://orm.drizzle.team) — schema-as-code, type-safe queries |
| Database | Postgres (works with any provider — production runs on [Neon](https://neon.tech)) |
| Auth | JWT + bcrypt |
| Uploads | Multer → Cloudinary streaming |
| AI | `@google/generative-ai` — `gemini-2.0-flash` (tagging + insight), `text-embedding-004` (NL search) |
| Validation | Zod schemas at every route boundary |

## Setup

```bash
# 1. Install
npm install

# 2. Copy env template and fill in
cp .env.example .env
#   → GEMINI_API_KEY       from aistudio.google.com/app/apikey
#   → DATABASE_URL         from neon.tech
#   → CLOUDINARY_*         from cloudinary.com
#   → JWT_SECRET           any 32+ char random string

# 3. Apply migrations
npm run db:migrate

# 4. Seed the catalog (50 sample assets)
npm run db:seed

# 5. Run
npm run dev             # tsx watch, port 4000 by default
```

`http://localhost:4000/health` should return `{ ok: true, ... }`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Watch-mode server via `tsx watch` |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run the compiled build |
| `npm run db:generate` | Regenerate SQL migrations from schema |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Insert the 50-asset seed catalogue (idempotent) |
| `npm run db:reset` | Drop and recreate the public schema (dev only) |

## API surface (in progress)

Auth
- `POST /api/auth/signup` — create account, returns `{ token, user }`
- `POST /api/auth/login` — `{ token, user }`
- `POST /api/auth/logout`
- `GET  /api/auth/me` — current profile (requires `Authorization: Bearer <token>`)
- `PATCH /api/auth/me` — update name / role / bio / location / avatarUrl

Assets
- `GET  /api/assets` — paginated feed (`?type=PHOTO&tier=free&page=1&pageSize=24&sort=new|popular|trending`)
- `GET  /api/assets/search?q=…` — text search across title/tags/insight (upgraded to embeddings on Day 4)
- `GET  /api/assets/:id`

Everything else (uploads, favorites, collections, notifications) lands in
Days 3–5 per the roadmap.

## Directory shape

```
src/
├── index.ts              app shell (CORS, JSON, error handler, /health)
├── env.ts                Zod-validated env
├── auth/
│   ├── middleware.ts     signToken, requireAuth, attachUser
│   └── routes.ts         signup / login / me
├── db/
│   ├── schema.ts         Drizzle tables + relations
│   ├── client.ts         postgres.js + drizzle
│   ├── migrate.ts        runs migrations from ./drizzle
│   ├── seed.ts           inserts the 50 mock assets
│   ├── seed-data.ts      the 50-asset data itself
│   └── reset.ts          dev-only: drop & recreate schema
├── lib/
│   ├── http.ts           HttpError + status helpers
│   ├── ids.ts            newId('usr'|'asset'|…)
│   └── asset-mapper.ts   AssetRow → PublicAsset (frontend shape)
└── routes/
    └── assets.ts         list / search / by-id
```
