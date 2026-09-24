---
name: permissions-can
description: >-
  Use when adding or editing any route, server action, API handler, or UI that
  checks a user's role, membership, or agency access in this platform.
---

# Permissions — can() only

## Rules

1. All authorization goes through `can(actor, action, resource)` from `packages/core/permissions.ts`.
2. **Banned:** `if (user.role === 'admin')`, `role ===`, membership role checks in UI/handlers.
3. Every new endpoint or server action needs a **permission test** (cross-tenant: Agency A must not edit Agency B).
4. When schema/resources change, update RLS policies to match (defence in depth on Supabase Postgres).
5. `(agency)` routes typically require owner|admin; `(agent)` requires membership. Still express via `can()`, not raw role strings in apps.

## Pattern

```ts
import { can } from '@repo/core/permissions'

if (!can(actor, 'listing:edit', listing)) {
  throw new Error('Forbidden')
}
```
