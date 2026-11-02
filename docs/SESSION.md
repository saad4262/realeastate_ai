# Session log (newest on top)

Entries before 2026-10-31 (late) are in `docs/archive/SESSION-to-2026-10-31.md`. Keep this file short: when it
passes ~10 entries, move the older ones to a new archive file.

## 2026-11-02 — Claude Code (Mac) — this laptop caught up; Retell agent; ADR 0074 part 2 (SMS everywhere)
- Goal: catch the Mac up after a week on the other laptop; Retell keys; then 3.4 part 2 on the user's answers.
- Done: `retell:setup` against the Vercel web domain (`RETELL_AGENT_ID=agent_93b24a5de57c293fe91e59d943`, set in the
  Mac `.env.local`; Vercel envs left to the user — the agent may not write Vercel secrets). Checked first that Vercel's
  INTEGRATION_TOKEN_KEY is the Mac's (the deployed webhook answered 400 to a token made with the local key, not 403).
  ADR 0074 part 2 on `feat/sms-part2` (from `chore/tech-debt`): migration 0079, `phone/sms-rules.ts`,
  `template-email/sms-batches.ts`, step `send_template_sms`, skills `bulk_sms` + `workflow_texts`, minute job
  `smsBatches`, missed-call text now 3 automatic a caller + 100 a number, console Bulk SMS / Text selected / Texts to
  customers. Unit: core 1556, ai 335; console build OK; lint 0 errors. Break-tests: rule-2 order and the
  never-as-email guard each red, then green. The tool-CHECK test caught a stray ")" in 0079 — fixed.
- Decisions (the user): numbers come with Twilio tonight; consent — the user asked for "everyone once the skill is on",
  kept at the Bulk email rule (Spam Act), told the user why; 9–8 OK; 3 automatic texts a caller (not 1); 100 a number OK.
  New guard: `SMS_DEV_ALLOWLIST` (dev DB = production DB, a real key would text real people).
- Then: 0079 dry run (rolled back, twice, clean); the agent was refused applying it (auto mode: production), the user
  applied it from this Mac (two earlier tries reached another database — checked read-only each time); smoke "SMS
  everywhere (ADR 0074)" 1/1 green; committed on `feat/sms-part2`.
- Left unfinished (exact next step): push `feat/sms-part2` and merge (the user's go); Vercel envs (the user, doing it);
  the Voyage backfill (on hold — the user); Twilio tonight → TEST-PLAN BX/BY/BZ/CE.
- Risks / watch: 0079 must be applied before this code reaches production; "Text selected" only ticks buyers the email
  rule allows (ADR 0060 decision 4) — a buyer with a mobile but no email cannot be texted from that tab yet.

## 2026-10-31 — Claude Code (Mac) — SMS part 1, ADR 0075, Outlook, AI understands, Phase 7 mocks, tech debt
- Goal: the user's v1 list while the client reviews; then the Phase 7 mocks; then clean the house.
- Done: ADR 0074 (SMS templates by channel, `call.missed`), ADR 0075 + 0076 (one address, several agencies; zero-
  downtime two-step), ADR 0076 Outlook (migration 0077), ADR 0078 AI understands (migration 0078, plus the missing
  `switch_skill` in the tool CHECK) — all merged to `main`, smoke groups green. Mocks for the client: SMS rules,
  Control Centre, 4.4 triggers. Phase 7 mocks for the user (approved): voice control, Property Management,
  recruitment + training, team workload board. Tech debt on `chore/tech-debt`: CI, STATUS/SESSION archived, smoke reds fixed (cron reads vercel.json; the inbox
  check counts contact threads; two team loaders), each broken on purpose and seen red.
- Files touched: `.github/workflows/ci.yml`, `packages/smoke/src/index.ts`, two `team/**/loading.tsx`, `docs/STATUS.md`, `docs/SESSION.md`, `docs/archive/`, `docs/HANDOFF.md`,
  `docs/ROADMAP.md`, `docs/mocks/` (four Phase 7 mocks + README).
- Decisions: Phase 6, Xero, CRM connectors AND Phase 7 are version 2 (the user). CI gets no secrets.
- Left unfinished (exact next step): merge `chore/tech-debt` (the user's go), a full smoke run, the two local-only
  branches (keep or delete — the user).
- Risks / watch: dev DB = production DB; never run the minute cron locally; test agency only; alias emails only.
