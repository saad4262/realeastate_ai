---
name: surface-boundaries
description: >-
  Use when adding or editing any route, page, layout, middleware, or component
  in apps/web or apps/console — especially agent vs agency surfaces, host
  routing, or shared UI placement.
---

# Surface boundaries

## Surfaces (3 UIs, shared core)

| Host | App | Route group | Chrome | Audience |
|------|-----|-------------|--------|----------|
| `site.com.au` / `web.lvh.me` | `apps/web` | — | Consumer shell (`AppShell` / later marketing) | Buyers / renters |
| `agents.*` | `apps/console` | `(agent)` | **`AgentShell`** (dark desk) | Individual agents |
| `agency.*` | `apps/console` | `(agency)` | **`AgencyShell`** (Stitch Agency OS) | Principals / admins |
| both console hosts | `apps/console` | `(shared)` | Auth shells only | login / signup / sign-out |

**Shared core** = `packages/ui` (tokens, Button, primitives) + `packages/core` (can(), domain).  
**Do not** reuse Agency OS sidebar on agent or web. Each surface has its own shell; business logic stays in packages.

## Rules

1. **agents.* and agency.* are ONE app** — never fork into a third app without ADR + split triggers.
2. Resolve surface from **host header in middleware** — never hardcode surface in pages.
3. **No business logic in `apps/`.** If `(agent)` and `(agency)` both need it → `packages/core`.
4. **Never import across apps/** — share only via `packages/`.
5. Do not copy the same logic into both route groups; extract shared packages/components.
6. **Nav/chrome is surface-specific** — `AgencyShell` vs `AgentShell` vs web. Shared primitives only in `packages/ui`.

## Layout reminder

```
apps/console/app/
  (agency)/agency-shell.tsx + overview|team …
  (agent)/agent-shell.tsx + listings …
  (shared)/login|signup …   ← no Agency/Agent chrome
apps/web/                   ← consumer only
packages/ui/                ← shared Button, tokens, AppShell (web/legacy)
```
