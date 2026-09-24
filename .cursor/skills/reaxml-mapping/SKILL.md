---
name: reaxml-mapping
description: >-
  Use when designing schema fields for listings/properties, planning CRM import
  or export, or mapping REAXML elements to this platform's Drizzle schema.
---

# REAXML mapping

Keep our schema a **superset** of REAXML so M6 import is a mapping file, not a migration.

## Workflow

1. Read [reference.md](reference.md) for the field map.
2. When adding a listing/property field, update the map in the same change.
3. Prefer REAXML-aligned names where sensible; document aliases in the map.

## Do not

- Invent import-only columns that ignore portal/agent UX needs.
- Break `property` vs `listing` separation for feed convenience.
