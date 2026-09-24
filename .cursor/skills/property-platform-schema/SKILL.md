---
name: property-platform-schema
description: >-
  Use when adding or editing any database table, Drizzle migration, schema field,
  or query involving properties, listings, agencies, agents, or media in this
  platform. Enforces property ≠ listing and REAXML-shaped naming.
---

# Property platform schema

## Rules

1. **property !== listing.** Never merge. Property = physical place; listing = an ad over time.
2. Never add `listing.agent_id`. Use join table `listing_agent` with `role` (`lead` | `co` | `property_manager`), `display_order`, and **required** `snapshot_name`, `snapshot_phone`, `snapshot_email`.
3. Always store **both** `price_display` (string) and `price_from` / `price_to` (numeric). Never parse the display string at query time.
4. Keep field names REAXML-compatible / a superset (category, status, price/priceView, beds/baths/cars, landDetails, inspectionTimes, images with main, listingAgent).
5. Every table gets `created_at` and `updated_at`.
6. Types come from `packages/db/schema.ts` only — never hand-write duplicate types.
7. Org tree: agency → office → team → membership → agent_profile (profile ≠ user).

## Before migrating

- Read `packages/db/src/schema.ts` and `docs/architecture.md` data model section.
- If inventing a new core entity, write a short ADR first.
