# Architecture — AI-Driven Property Platform

Master Plan v2. This document is **input** for humans and agents — not something to invent from scratch.

## Surface model — 3 domains, 2 apps

| Domain | App | Role |
|--------|-----|------|
| `site.com.au` | `apps/web` | Public consumer, SEO/ISR critical |
| `agents.site.com.au` | `apps/console` | Agent surface (host-routed) |
| `agency.site.com.au` | `apps/console` | Agency surface (same app) |

Client gets three URLs and **three distinct UIs**. One codebase, one auth, shared packages — **not** one nav. Agency and agent share `apps/console` because AU principals are often lead agents too; chrome and IA differ per surface. Splitting 2→3 apps later is cheap; merging 3→2 is expensive.

| Surface | Shell | Shared |
|---------|-------|--------|
| Agency | `AgencyShell` (Stitch Agency OS) | `packages/ui` primitives + `packages/core` |
| Agent | `AgentShell` (dark desk) | same |
| Consumer | web marketing shell (`AppShell` for now) | same |

Consumer stays a separate app: aggressive caching/SEO vs session-heavy console. Traffic spikes stay isolated. ~90% of code lives in `packages/`.

### Host routing (`apps/console`)

Middleware reads the `Host` header:

- `agents.*` → surface `agent` → default `/listings` → `AgentShell`
- `agency.*` → surface `agency` → default `/overview` → `AgencyShell`

Route groups: `(agent)`, `(agency)`, `(shared)`. Surface comes from middleware — never hardcode. `(shared)` = auth only (no agency/agent chrome).

### When to add a third app

Only if: agency becomes a separate product; white-label per agency; 3+ frontend owners; or agency deps bloat the agent bundle.

**Open decision:** white-label (`raywhite.site.com.au`)? Day-1 assumes **No** (fixed three hosts). Confirm with client before M0 locks routing.

## Auth across subdomains

Use subdomains of one root so the session cookie can be set on `.site.com.au` (local: `.lvh.me`). Separate root domains need full SSO — avoid that. **Supabase Auth** via `@supabase/ssr` lives in `packages/auth`; cookie domain from `COOKIE_DOMAIN` (ADR 0003 / 0004).

Local: `web.lvh.me:3000`, `agents.lvh.me:3001`, `agency.lvh.me:3001`, `COOKIE_DOMAIN=.lvh.me`.

App `user.id` = `auth.users.id`. Membership/roles stay in Drizzle + `can()`.

## Monorepo

```
apps/web, apps/console
packages/: db, core, auth, ai, ui, config
```

- **db** — Drizzle schema + migrations + seed (source of truth)
- **core** — `can()`, search port, domain logic
- **auth** — Supabase Auth SSR, cross-subdomain cookie from `COOKIE_DOMAIN`
- **ai** — isolated LLM module
- **ui** — tokens, shadcn, AppShell
- **config** — zod env

Infra: Supabase Postgres + PostGIS + pgvector (dev may be Seoul; prod Sydney later). Auth = Supabase Auth. Media = Cloudflare R2. **Not used:** Supabase Storage.

## Data model (rewrite risk)

**property ≠ listing.** Property is the physical place; listing is an ad over time. Never merge; never `listing.agent_id` — use `listing_agent` with lead/co roles, display order, and snapshot name/phone/email.

Store `price_display` (string) and `price_from` / `price_to` (numeric). Never parse the string at query time.

Org: agency → office → team → membership (roles) → agent_profile (public, separate from user). Membership drives both console surfaces.

Permissions: only `can(actor, action, resource)` in `packages/core/permissions.ts`. No `if (user.role === …)` in UI. Add Postgres RLS for defence in depth.

Other tables: media, inspection, lead, saved_search, shortlist, event (outbox), ai_run (cost/audit from day one). Keep fields REAXML-shaped for later CRM import.

## Search

Postgres first (PostGIS + GIN/trigram + filters). Expose `SearchPort` in `packages/core/search.ts` so Typesense can swap later without a rewrite.

## AI architecture

All LLM calls only in `packages/ai/` via `usage.ts` → `ai_run`. Versioned prompts; zod structured output; LLM never invents numbers (SQL/tools supply them); no `new Date()` in system prompts; bulk via Batch API; AI listing copy is draft-only until human approve; citations required; no auto-reject tenant screening.

Default model routing: Opus for hard reasoning; Sonnet/Haiku for bulk. Embeddings: Voyage / OpenAI / bge-m3 → pgvector.

## Build order

| Milestone | Focus |
|-----------|--------|
| M0 | Schema, Supabase Auth + cookie, `can()`, RLS, seed |
| M1 | Console CRUD, media, host routing, team/roles |
| M2 | Consumer search, SEO, schema.org |
| M3 | AI v1: NL search, enrichment, Q&A |
| M4 | Accounts, shortlist, alerts + unsubscribe, digest |
| M5 | Agent/agency AI + Stripe |
| M6 | REAXML, Typesense if needed |

Do not build: microservices, Kafka, Elasticsearch early, micro-frontends, third app without triggers, custom ML AVM, React Native before PWA.

## Compliance (AU)

Privacy Act / APPs, Spam Act (working unsubscribe), ACL (misleading ads), copyright (no scraping portal images), NSW underquoting rules, no auto-decisioning on rental applications.

## Dual-tool handoff

Cursor and Claude Code share git truth: `docs/STATUS.md`, `docs/SESSION.md`, `docs/memory/`, `AGENTS.md` / `CLAUDE.md`, one skills tree. Prefer Cursor for UI apps; Claude Code for db/core/auth/ai.
