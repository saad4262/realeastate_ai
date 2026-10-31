# Status — 2026-10-31 (Claude Code, Mac)

Short on purpose: where things stand now. History up to 2026-10-31 is in `docs/archive/STATUS-to-2026-10-31.md`;
how to work on either laptop is `docs/HANDOFF.md`. Overwrite this file at each handoff; do not append.

## Milestone
Version 1 is built except what waits on the client. `main` = `d3eb906` (4.5 "AI understands" merged), deployed.
Branch `chore/tech-debt` (pushed, NOT merged): CI, this docs trim, the three smoke reds fixed, two team loaders,
the four Phase 7 mocks.

## Database
79 migrations recorded (0000–0078). Nothing pending. Dev database = production database (one `DATABASE_URL`).

## Checks
- CI (`.github/workflows/ci.yml`, new): typecheck, lint, `pnpm test` on every push, no secrets given; Node from
  `.nvmrc` (now 22). Green on GitHub for `48ab812` (2.5 min). Its first runs caught two things the Mac hid:
  `packages/config` lacked `@types/node` (a stray copy in the home folder covered it), and unpdf needs Node 22+
  (`Iterator`). **Check Vercel → each project → Settings → Node.js Version is 22 or later**, or PDF reading
  (ADR 0053) fails in production.
- Unit: core 1537, ai 335, auth 9, ui 4 — all pass, offline.
- Smoke: run by hand with the user's go, in named groups (`SMOKE_ENABLED=true SMOKE_ONLY="<group>"`). The three
  known reds are fixed and each was seen red when broken: Console loaders 1/1, Search schedules 17/17, Email
  conversations 7/7. A full run (the green baseline) has NOT been done since — the user's go first.

## Done this period (details in the ADRs and the archive)
3.4 part 1 SMS templates + `call.missed` (ADR 0074) · one address, several agencies (ADR 0075, the technical debt) ·
5.2 Outlook mail and calendar (ADR 0076) · 4.5 AI understands enquiries (ADR 0078, also fixed `switch_skill` cards).

## Blocked on the client
- **14 decisions in three mocks** (private Artifacts, links in `docs/mocks/README.md`): SMS rules (5) → 3.4 part 2;
  Control Centre (4) → 4.6/4.7; 4.4 triggers (5).
- **Keys:** Twilio test account (KYC), Retell, Voyage, the Microsoft Entra app, the temporary domain.

## Open decisions (the user)
- 5.1 public API + webhooks: the user's API decisions first.
- **Phase 7 is version 2 (the user, 2026-10-31):** voice control, Property Management, recruitment + training, team
  workload board. All four mocks approved by the user (internal, not the client); no code until version 2.

## Next
1. Merge `chore/tech-debt` to `main` (the user's go); then a full smoke run for the green baseline (the user's go).
   Local-only branches `feat/crm-visibility` (8 commits) and `feat/crm-assistant-more` (18) are not on GitHub;
   keep or delete is the user's call (their worktrees: `../realestate_ai-visibility`, `../realestate_ai-more`).
2. When the client answers: 3.4 part 2, then 4.6/4.7, then 4.4.
3. When keys arrive: Voyage backfill; `retell:setup`; TEST-PLAN BX/BY/BZ with real Twilio + Retell; Outlook (CC).
4. Last: the user's browser walk (TEST-PLAN BN–BZ, CA–CD), then go-live (`docs/DEPLOY.md`, `docs/DNS-CUTOVER.md`).

## Watch
- Planted words in an enquiry pass the AI fact check (ADR 0078 known limit); the approval card is the guard.
- Never run `/api/cron/minute` locally; test only on `phone-test-agency-20261030-dev`; alias emails only.
