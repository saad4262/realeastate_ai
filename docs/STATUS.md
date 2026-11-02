# Status — 2026-11-02 (Claude Code, Mac)

Short on purpose: where things stand now. History up to 2026-10-31 is in `docs/archive/STATUS-to-2026-10-31.md`;
how to work on either laptop is `docs/HANDOFF.md`. Overwrite this file at each handoff; do not append.

## Milestone
Version 1 is built except what waits on the client and on Twilio. `main` = `d3eb906`, deployed. Branches, not merged:
`chore/tech-debt` (pushed: CI, docs trim, smoke reds fixed, Phase 7 mocks) and **`feat/sms-part2`** (on top of it,
committed, NOT pushed: ADR 0074 part 2 — SMS everywhere).

## Database
80 migrations recorded (0000–0079). **0079 APPLIED 2026-11-02** by the user (from this Mac), after a rolled-back
dry run twice in one transaction (clean; 8/8 columns, old batches stay email, settings got the defaults, both CHECKs
hold). The deployed `main` does not read the new columns, so it is unaffected. Dev database = production database.

## Checks
- Unit: core 1556, ai 335 — all pass, offline. Console build OK (eight new routes); lint 0 errors.
- CI: green on `chore/tech-debt` (`48ab812`). Vercel projects are on Node 24 (unpdf needs 22+): checked 2026-11-02.
- Smoke: "SMS everywhere (ADR 0074)" 1/1 green on the live database (183 s — many round trips to Sydney). A full
  run (the green baseline) has NOT been done since the tech-debt fixes — the user's go first.

## Done this period
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
- Push `feat/sms-part2`; merge `chore/tech-debt`, then `feat/sms-part2`.
- Vercel → web + both console projects: `RETELL_API_KEY`, `RETELL_AGENT_ID`, `EMBEDDINGS_PROVIDER=voyage`,
  `VOYAGE_API_KEY`, then redeploy — the user said 2026-11-02 they are doing it; not checked here.
- The Voyage backfill (`pnpm --filter @repo/ai search:backfill`) — paid, on the live database; on hold (the user).
- Local-only branches `feat/crm-visibility` and `feat/crm-assistant-more`: keep or delete.

## Next
1. Push `feat/sms-part2` and merge both branches (the user's go).
2. Twilio tonight → connect on the phone test agency → BX, BY, BZ, CE.
3. When the client answers: 4.6/4.7, then 4.4.
4. Last: the user's browser walk (TEST-PLAN BN–BZ, CA–CE), then go-live (`docs/DEPLOY.md`, `docs/DNS-CUTOVER.md`).

## Watch
- "Text selected" ticks only buyers the email rule allows (ADR 0060 decision 4): a buyer with a mobile and no email
  cannot be texted from that tab yet — Bulk SMS with a filter reaches them.
- Planted words in an enquiry pass the AI fact check (ADR 0078 known limit); the approval card is the guard.
- Never run `/api/cron/minute` locally; test only on `phone-test-agency-20261030-dev`; alias emails only.
