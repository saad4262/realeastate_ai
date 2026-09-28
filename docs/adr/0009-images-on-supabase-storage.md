# 0009 — Images live in Supabase Storage, addressed by key

**Status:** accepted, 2026-09-25. Supersedes nothing; defers ADR-less R2 plan in CLAUDE.md.

**Context.** The `media` table has existed since the schema was written and
nothing populated it. R2 was the stated destination and has no account, no
bucket and no client code — only optional env slots. Supabase is already the
database and the auth provider, so its Storage is one bucket away.

**Decision.** Listing photos and agent portraits go in a single **public**
Supabase Storage bucket, `media`, under `listings/<id>/` and `agents/<id>/`.
Rows store a **key**, never a URL — `media.storage_key` and the new
`agent_profile.photo_key`. `mediaUrl()` in `packages/core/src/media` is the
only thing that turns a key into a URL.

**Why public.** These are public property ads. Signed URLs expire, which
poisons an ISR-cached page and a CDN — a URL that works when the page renders
and 403s an hour later is worse than no image.

**Why writes are still closed.** The bucket has no RLS insert policy, so the
anon key cannot write to it. Uploads go browser → storage directly, via a
short-lived signed URL the server issues only after `can()` agrees, and the
row is written only after the object is confirmed to exist. `pnpm smoke`
asserts the anon key is refused.

**Consequence.** Moving to R2 is a change to `mediaUrl()` and the storage
client, not a migration: no row and no component knows the host. `next.config`
and `mediaUrl` both derive the host from `NEXT_PUBLIC_SUPABASE_URL` so they
cannot drift.
