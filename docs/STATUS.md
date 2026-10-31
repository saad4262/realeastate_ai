# Status — 2026-10-31 (Claude Code, Mac)

Short on purpose: where things stand now. History up to 2026-10-31 is in `docs/archive/STATUS-to-2026-10-31.md`;
how to work on either laptop is `docs/HANDOFF.md`. Overwrite this file at each handoff; do not append.

## Milestone
Version 1 is built except what waits on the client. `main` = `d3eb906` (4.5 "AI understands" merged), deployed.
Branch `chore/tech-debt` (not merged yet): CI, this docs trim, the smoke reds, the four Phase 7 mocks.

## Database
79 migrations recorded (0000–0078). Nothing pending. Dev database = production database (one `DATABASE_URL`).

## Checks
- CI (`.github/workflows/ci.yml`, new): typecheck, lint, `pnpm test` on every push, no secrets given.
- Unit: core 1537, ai 335, auth 9, ui 4 — all pass, offline.
- Smoke: run by hand with the user's go, in named groups (`SMOKE_ENABLED=true SMOKE_ONLY="<group>"`).

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
1. Merge `chore/tech-debt` to `main` (the user's go).
2. When the client answers: 3.4 part 2, then 4.6/4.7, then 4.4.
3. When keys arrive: Voyage backfill; `retell:setup`; TEST-PLAN BX/BY/BZ with real Twilio + Retell; Outlook (CC).
4. Last: the user's browser walk (TEST-PLAN BN–BZ, CA–CD), then go-live (`docs/DEPLOY.md`, `docs/DNS-CUTOVER.md`).

## Watch
- Planted words in an enquiry pass the AI fact check (ADR 0078 known limit); the approval card is the guard.
- Never run `/api/cron/minute` locally; test only on `phone-test-agency-20261030-dev`; alias emails only.
