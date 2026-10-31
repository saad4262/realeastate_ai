# Session log (newest on top)

Entries before 2026-10-31 (late) are in `docs/archive/SESSION-to-2026-10-31.md`. Keep this file short: when it
passes ~10 entries, move the older ones to a new archive file.

## 2026-10-31 — Claude Code (Mac) — SMS part 1, ADR 0075, Outlook, AI understands, Phase 7 mocks, tech debt
- Goal: the user's v1 list while the client reviews; then the Phase 7 mocks; then clean the house.
- Done: ADR 0074 (SMS templates by channel, `call.missed`), ADR 0075 + 0076 (one address, several agencies; zero-
  downtime two-step), ADR 0076 Outlook (migration 0077), ADR 0078 AI understands (migration 0078, plus the missing
  `switch_skill` in the tool CHECK) — all merged to `main`, smoke groups green. Mocks for the client: SMS rules,
  Control Centre, 4.4 triggers. Phase 7 mocks for the user (approved): voice control, Property Management,
  recruitment + training, team workload board. Tech debt on `chore/tech-debt`: CI, STATUS/SESSION archived.
- Files touched: `.github/workflows/ci.yml`, `docs/STATUS.md`, `docs/SESSION.md`, `docs/archive/`, `docs/HANDOFF.md`,
  `docs/ROADMAP.md`, `docs/mocks/` (four Phase 7 mocks + README).
- Decisions: Phase 6, Xero, CRM connectors AND Phase 7 are version 2 (the user). CI gets no secrets.
- Left unfinished (exact next step): the smoke reds (see STATUS), then merge `chore/tech-debt` with the user's go.
- Risks / watch: dev DB = production DB; never run the minute cron locally; test agency only; alias emails only.
