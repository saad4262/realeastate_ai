# AGENTS.md

## Stack
pnpm + Turborepo monorepo.
apps/web     — public consumer, Next.js 15 App Router, SSR/ISR, site.com.au
apps/console — agent + agency, host-routed:
               agents.site.com.au → (agent)  route group
               agency.site.com.au → (agency) route group
packages/: db (Drizzle), core, auth (Supabase Auth SSR), ai, ui, config
Supabase Postgres + PostGIS + pgvector (dev may be Seoul; prod Sydney later).
Auth: Supabase Auth. Media: Cloudflare R2.
NOT used: Supabase Storage.
TypeScript strict. Tailwind + shadcn/ui.

## Verifying
**`pnpm test` and `pnpm smoke` cost nothing and never call a real LLM.** Unit
tests run with the network blocked (`@repo/config/test-offline`); the smoke
suite's AI group is opt-in and skips unless `SMOKE_LIVE_AI=1`. A key being in
.env.local is NOT consent to spend it. Live AI is `pnpm smoke:ai`, run
deliberately. New AI code gets a fake client, never a live one.

`pnpm test` (unit) → `pnpm smoke` (live: DB, indexes, caching, speed, HTTP, fail-closed) →
docs/TEST-PLAN.md (manual, needs a browser). A new invariant belongs in `pnpm smoke`; a new
endpoint needs a permission test. **Break the thing a new check guards and confirm it goes red
before trusting it** — a timing budget and an empty-row fake both passed while the bug they
were written for was present.

## Writing to the database
Multi-step writes go in `db.transaction`. Helpers that write take `DbOrTx`, never `Db`.
Network calls (geocoding) happen **before** the transaction opens — never inside one.
Reads have a known query count; adding one per row is an N+1 and `query-count.test.ts`
will say so.

## Session boot (do this first, every session)
1. Read docs/STATUS.md
2. Read top 1-2 entries of docs/SESSION.md
3. If the task matches a skill in .cursor/skills/, read that skill
4. Only then explore code. Do not full-repo scan by default.
At session end (or on "wrap up" / "handoff"):
   overwrite docs/STATUS.md, append an entry to docs/SESSION.md.

## Tool split
Cursor      → apps/web, apps/console, packages/ui
Claude Code → packages/db, packages/core, packages/auth, packages/ai
Either may touch shared packages. Handoff files are the source of truth.

## Non-negotiables
1.  property !== listing. Never merge. Never add listing.agent_id — use listing_agent.
2.  Never write `if (user.role === ...)`. Always can(actor, action, resource)
    from packages/core/permissions.ts. Every new endpoint needs a permission test.
3.  Never call an LLM outside packages/ai/. Every call goes through usage.ts → ai_run.
4.  LLM never produces a number. Prices, medians, days-on-market come from SQL.
    Pass numbers to the model as tool results; never ask it to calculate.
5.  Never put `new Date()` in a system prompt — it breaks prompt caching.
6.  price_display (string) AND price_from/price_to (numeric) are both stored.
    Never parse the string at query time.
7.  AI-written listing copy is always a draft. Never auto-publish.
8.  Types are derived from packages/db/schema.ts. Never hand-write a duplicate type.
9.  Two apps, THREE domains, ONE database, ONE packages layer.
    agents.* and agency.* are the SAME app — never fork them.
10. No business logic in apps/. If two route groups need it, it belongs in packages/core.
11. Never import across apps/. Share through packages/ only.
12. Surface is resolved from the host header in middleware. Never hardcode a surface.
13. Auth cookie domain comes from env (COOKIE_DOMAIN). Never hardcode a domain.
14. App user.id matches Supabase auth.users.id. Membership/roles live in our DB + can(), not only JWT claims.

## Engineering rules
ARCHITECTURE.md is the standing SOP: rendering, navigation, state, data
fetching, caching, validation, performance budgets and the verification
discipline. Read it before adding a page, a query, a component or an endpoint.
This file is the domain law; that file is how the app is built. Both apply.

## Before writing code
- Write types + zod schemas (the contract) first.
- Check .cursor/skills/ before starting any task.
- Big decision? Write docs/adr/NNNN-title.md (10 lines) first.
- Verify fast-moving APIs (Supabase SSR, Next.js 15, Drizzle) with Context7. Not from memory.
