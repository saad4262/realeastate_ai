# Status — 2026-11-02, later (Claude Code, Mac)

Short on purpose: where things stand now. History up to 2026-10-31 is in `docs/archive/STATUS-to-2026-10-31.md`;
how to work on either laptop is `docs/HANDOFF.md`. Overwrite this file at each handoff; do not append.

## Milestone
Version 1 is built except what waits on the client and on Twilio. `main` = `d3eb906`, deployed. Branches, not merged:
`chore/tech-debt` (pushed: CI, docs trim, smoke reds fixed, Phase 7 mocks), **`feat/sms-part2`** (on top of it,
committed, NOT pushed: ADR 0074 part 2 — SMS everywhere) and **`feat/customer-profile`** (on top of that, committed,
NOT pushed: ADR 0079 — the customer profile). Merge in that order.

## Database
80 migrations recorded (0000–0079; 0079 applied 2026-11-02). **0080 (`contact.address_*`, six nullable columns)
written, rolled-back dry run clean (twice in one transaction; 10 contacts untouched; a pin round-trips), NOT applied**
— the user's go. `feat/customer-profile` READS those columns (contact pages, directory, import): it must not be
deployed before 0080 is applied. Dev database = production database.

## Checks
- Unit: core 1579, ai 335 — all pass, offline. Typecheck 10/10. Console build OK; lint 0 errors.
- Smoke for ADR 0079 — "Customer profile (ADR 0079)" (new) and the contacts-import check in "Imports: contacts and
  Google Sheets" (rewritten: a repeat now fills the profile instead of being skipped) — written, NOT run: they need 0080.
- CI: green on `chore/tech-debt` (`48ab812`). Vercel projects are on Node 24 (unpdf needs 22+): checked 2026-11-02.
- Smoke: "SMS everywhere (ADR 0074)" 1/1 green on the live database (183 s — many round trips to Sydney). A full
  run (the green baseline) has NOT been done since the tech-debt fixes — the user's go first.

## Done this period
- 2026-11-02: ADR 0079 — the customer profile. Add customer asks for name, email, phone and address (the listing
  form's picker; no server geocoding); the same email adds to that profile (blanks filled, nothing overwritten, other
  values on the timeline as "Different details given"; linked only for someone who may see it); the import takes
  Street address / Suburb / State / Postcode and fills existing people (`updated`) instead of skipping them; "missing"
  chips on the list and the profile; search by suburb; a merge carries the address. TEST-PLAN CF.
- 2026-11-02: ADR 0074 part 2 on the user's answers to the five SMS rules — Bulk SMS (`/bulk-sms`, `/my-bulk-sms`),
  "Text selected" on Matching buyers, the workflow step "Send SMS" (pair skill Workflow texts), the pair skill Bulk SMS,
  the agency number, 9 am–8 pm, 3 automatic texts a caller (missed call + workflow), 100 texts a number, and
  `SMS_DEV_ALLOWLIST` for dev with a real key. Consent stays the Bulk email rule (the user asked for "everyone"; the
  Spam Act needs consent — explained).
- 2026-11-02: the Retell agent made (`agent_93b24a5de57c293fe91e59d943`, webhook on `realestate-ai-users.vercel.app`).
- Before: 3.4 part 1 (ADR 0074) · ADR 0075 · Outlook (ADR 0076) · AI understands (ADR 0078).

## Blocked on the client
- Twilio test account (KYC) — promised tonight; then numbers, and TEST-PLAN BX/BY/BZ/CE with real Twilio + Retell.
- The client's approval of the SMS rules (built on the user's answers), Control Centre (4) → 4.6/4.7, 4.4 triggers (5).
- The Microsoft Entra app (Outlook), the temporary domain (then `retell:setup` again and `phone:repoint`).

## Waiting on the user
- Apply 0080 (`pnpm --filter @repo/db db:migrate`, expect 81 recorded), then smoke `SMOKE_ONLY="Customer profile (ADR
  0079),Imports: contacts and Google Sheets"`, then TEST-PLAN CF in a browser.
- Push `feat/sms-part2`; merge `chore/tech-debt`, then `feat/sms-part2`.
- Vercel → web + both console projects: `RETELL_API_KEY`, `RETELL_AGENT_ID`, `EMBEDDINGS_PROVIDER=voyage`,
  `VOYAGE_API_KEY`, then redeploy — the user said 2026-11-02 they are doing it; not checked here.
- The Voyage backfill (`pnpm --filter @repo/ai search:backfill`) — paid, on the live database; on hold (the user).
- Local-only branches `feat/crm-visibility` and `feat/crm-assistant-more`: keep or delete.

## Next
1. 0080 + its smoke (above); then push and merge `chore/tech-debt` → `feat/sms-part2` → `feat/customer-profile`
   (the user's go).
2. Twilio tonight → connect on the phone test agency → BX, BY, BZ, CE.
3. When the client answers: 4.6/4.7, then 4.4.
4. Last: the user's browser walk (TEST-PLAN BN–BZ, CA–CE), then go-live (`docs/DEPLOY.md`, `docs/DNS-CUTOVER.md`).

## Watch
- ADR 0079: the assistant's create/update contact cards do not take an address yet; imported addresses are not
  geocoded (no pin); every enquiry-made contact shows "Address missing" — by design (the user's answer 3).
- "Text selected" ticks only buyers the email rule allows (ADR 0060 decision 4): a buyer with a mobile and no email
  cannot be texted from that tab yet — Bulk SMS with a filter reaches them.
- Planted words in an enquiry pass the AI fact check (ADR 0078 known limit); the approval card is the guard.
- Never run `/api/cron/minute` locally; test only on `phone-test-agency-20261030-dev`; alias emails only.
