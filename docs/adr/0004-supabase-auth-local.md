# ADR 0004 — Supabase Auth for local; Sydney later

## Context
Master Plan v2 specified Better Auth. For local testing (1–2 weeks) the team chose Supabase Auth on the existing Seoul project to move faster. Membership/roles must still live in our Drizzle tables and `can()`.

## Decision
- Use **Supabase Auth** (`auth.users`) as identity. App `user.id` = `auth.users.id`.
- Keep **Better Auth out** for now; revisit for production if cross-subdomain or org flows hurt.
- Seoul (`ap-northeast-2`, project `ydzceumpiaqhpaoerivd`) = **dev/local only**.
- Production DB/Auth region = **Sydney** in a later project cutover.
- Cloudflare R2 for media — **not** Supabase Storage.

## Alternatives
- Better Auth (original plan) — deferred.
- Supabase Auth + Supabase Storage — rejected; media stays R2.

## Consequences
Update AGENTS.md / env (no BETTER_AUTH_*). Cookie sharing via `@supabase/ssr` + `COOKIE_DOMAIN`. Seed may use `SUPABASE_SERVICE_ROLE_KEY`.
