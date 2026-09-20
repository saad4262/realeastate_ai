# Realestate AI — Property Platform

Sydney / NSW first (market). **3 domains / 2 apps**: public consumer (`apps/web`) and host-routed agent + agency console (`apps/console`).

## Prerequisites

- Node 20+
- pnpm 9+
- Supabase project (dev may be Seoul; production Sydney later) with PostGIS + pgvector
- Auth: **Supabase Auth** · Media: **R2** (not Supabase Storage)

## Setup

```bash
pnpm install
cp .env.example .env.local
# Set DATABASE_URL (pooler :6543), DIRECT_URL (direct :5432),
# NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
pnpm --filter @repo/db db:migrate
pnpm --filter @repo/db db:seed
pnpm dev
```

Local hosts (`lvh.me` → 127.0.0.1):

| URL | App |
|-----|-----|
| http://web.lvh.me:3000 | Public site |
| http://agents.lvh.me:3001 | Agent console |
| http://agency.lvh.me:3001 | Agency console (same app) |

## Monorepo

- `apps/web` — public, SEO/ISR
- `apps/console` — agent + agency via host middleware
- `packages/db` — Drizzle (schema source of truth)
- `packages/core` — permissions, search port, domain
- `packages/auth` — Supabase Auth SSR + `COOKIE_DOMAIN`
- `packages/ai` — isolated LLM module (M3)
- `packages/ui` — design system
- `packages/config` — zod env

## Build order (UI first, then backend)

Per surface — polish frontend (Stitch demos, motion, empty states) until satisfied, **then** wire Drizzle / Supabase Auth / `can()`. Do not ship full UI+API in one pass.

1. **Agency console** — `apps/console` `(agency)` on `agency.lvh.me` ← **current**
2. **Agent console** — same app `(agent)` on `agents.lvh.me` ← later
3. **Consumer web** — `apps/web` on `web.lvh.me`

Shared login (`/login`) uses Agency OS Stitch branding for now.

## MCP

```bash
cp .cursor/mcp.json.example .cursor/mcp.json
# Fill Stitch / Context7 / Supabase tokens locally.
# .cursor/mcp.json is gitignored — never commit API keys.
```

Then **Cursor → Settings → MCP → reload**, or restart Cursor, so `stitch` appears.

## Agent workflow (Cursor + Claude Code)

1. Every session: read `docs/STATUS.md` then `docs/SESSION.md`
2. Skills live in `.cursor/skills/` (symlinked at `.agents/skills`)
3. End of session: say **handoff** — update STATUS + append SESSION
4. Prefer Cursor for UI; Claude Code for db/core/auth/ai

See `AGENTS.md` for non-negotiables. Architecture: `docs/architecture.md`. ADRs: especially 0004 (Supabase Auth / Seoul=dev).

## Scripts

| Command | What |
|---------|------|
| `pnpm dev` | Both apps |
| `pnpm build` | Build all |
| `pnpm typecheck` | Typecheck all |
| `pnpm --filter @repo/db db:migrate` | Apply migrations |
| `pnpm --filter @repo/db db:seed` | Seed demo data |
| `pnpm --filter @repo/core test` | Permission tests |
