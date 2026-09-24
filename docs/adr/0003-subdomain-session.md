# ADR 0003 — Subdomain session cookie

## Context
Agents must move between `agents.site.com.au` and `agency.site.com.au` without re-login. Separate root domains cannot share cookies without a full SSO flow.

## Decision
Use subdomains of one root. Auth sessions (Supabase Auth via `@supabase/ssr`) set cookie domain from env (`COOKIE_DOMAIN=.site.com.au` in prod; `.lvh.me` locally). Auth helpers live in `packages/auth`.

## Alternatives
- Separate roots (`myagents.com` + `myagency.com`) — rejected: 1–2 weeks SSO overhead.
- Hardcoded cookie domain — rejected: breaks local vs prod.
- Better Auth cross-subdomain cookie — deferred (ADR 0004).

## Consequences
Local dev uses `*.lvh.me`. Never hardcode a domain in app code. Verify Supabase cookie options when wiring middleware.
