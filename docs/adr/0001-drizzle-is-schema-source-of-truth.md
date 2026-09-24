# ADR 0001 — Drizzle is the schema source of truth

## Context
We host Postgres on Supabase (Sydney) for PostGIS, pgvector, and future RLS. Supabase also offers its own migration/CLI workflow, which can fork schema ownership.

## Decision
Drizzle owns schema, migrations, and seed in `packages/db`. Supabase is the Postgres host (and later RLS target). Do not maintain a parallel `supabase/migrations` workflow for app tables.

## Alternatives
- Supabase CLI migrations as primary — rejected: duplicates SoT, drifts from TypeScript types.
- Prisma — rejected: team preference for SQL-close Drizzle and AI codegen quality.

## Consequences
Types derive from `packages/db/schema.ts`. RLS policies are written to match Drizzle tables. Agents must not invent tables outside this package.
