# Handoff — 2026-10-30, database state corrected 2026-10-31 (to the Claude on the other laptop)

You are taking over from the Claude that built Phases 1–4.3, the Skills rework, Phone & SMS (3.1–3.3), the
minute-tick batching and the DNS checklist. This file is everything you need that is not obvious from the code.
Read it fully once, then follow §7 "What to do next". Keep it current, or replace it with your own at your handoff.

---

## 0. Read in this order

1. This file.
2. `AGENTS.md` (via `CLAUDE.md`) — the domain law: 14 non-negotiables (property ≠ listing, `can()` only, LLM only
   in `packages/ai`, the LLM never produces a number, AI listing copy is a draft, no business logic in `apps/`…).
3. `ARCHITECTURE.md` — how the app is built (rendering, data fetching, verification discipline).
4. `docs/ROADMAP.md` — the client's 28 skills (Part 4 = the brief, nothing dropped), status (Part 1, refreshed
   today), the work order (Part 3).
5. `docs/STATUS.md` top entries and `docs/SESSION.md` top entry.
6. The ADR of whatever you touch (`docs/adr/`, 0057–0073 are this period's).

---

## 1. Database: nothing pending (corrected 2026-10-31)

An earlier version of this file said 0069 was not applied and 0070 was on hold. **That was wrong.** Checked on
the database 2026-10-31 (read-only; both laptops use the same `DATABASE_URL`):

| Migration | State |
|---|---|
| 0000–0073 | **all 74 recorded** in `drizzle.__drizzle_migrations` |
| 0069 (workflow triggers + `workflow_run.decision`) | applied: `workflow_event_kind_check` includes `appointment.completed`; the column exists |
| 0070 (skills default off, keeps Workflow emails on) | recorded; no active workflow sends a template email, so it had nothing to keep on |
| 0071–0073 (phone tables, missed-call settings, AI call back) | applied: tables, columns and RLS on `missed_call_setting` all present |

So completing an appointment works with `main`'s code, and **no migration is waiting. Do not run any.** The next
migration is a new one (0074, Phase 3.4) and, like every migration, only on the user's explicit go.

**What IS live, by the client's decision (ADR 0069): every skill is OFF until someone switches it on.** Today only
"Missed call text" and "AI call back" have switched-on rows (for the test agency). Every agency owner must turn
on the skills they want under Skills (agency switch; agents switch their own), or the assistant refuses those
tools and the automations do not run. Tell the client this before agencies use production.

---

## 2. The user and how to work with them

- **The user writes typo-heavy Roman Urdu. Reply in Roman Urdu** (English for code, docs, commits). When an ask is
  ambiguous, confirm before acting. They often paste messages written by/for their **boss (the client)** — those
  are the user's requests.
- **The client = the boss / project owner** who provides accounts and approves mocks. Not the end users.
- **Process for every feature (the user's decision):** HTML mock in `docs/mocks/` → the client approves → ADR in
  `docs/adr/` (short) → code (contract/types first) → TEST-PLAN section → tick ROADMAP. Mock first for any new UI.
- **Never without the user's explicit go:** applying a migration, pushing, merging, deploying, deleting data,
  sending anything to real people. A "theek hai" on a mock is the mock's approval, not a migration's go.
- **Commits:** this laptop had no git identity; commits used
  `git -c user.name="Muhammad Saad" -c user.email="102743691+saad4262@users.noreply.github.com" commit …`
  (the repo's existing author). End messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  One commit per step. Never commit `apps/*/next-env.d.ts` changes (the dev server rewrites them; `git checkout --` them).
- **Email sender stays `alerts@quotemydecking.com.au`** (Resend-verified). Never propose changing it.
- **The user wants proof, not claims:** say what you ran and what it printed; say plainly what you did not test.

---

## 3. The roadmap — what was planned, what is done

The client's brief: 28 skills (ROADMAP Part 4). The work order (ROADMAP Part 3), with today's state:

| Phase | Steps | State |
|---|---|---|
| 1. Finish what is half built | 1.1 sidebar groups · 1.2 Skills Control Centre · 1.3 `find_buyers` · 1.4 matched buyers on the listing · 1.5 roles prospect / past client / referral partner · 1.6 inbox assistant | ✅ done (ADR 0057–0062) |
| 2. Money | 2.1 deal pipeline · 2.2 commissions + Finance · 2.3 property page | ✅ done (ADR 0063–0065) |
| 3. Phone + SMS | 3.1 Twilio connector + texts · 3.2 missed call text + Missed Calls page · 3.3 Retell AI call back · **3.4 SMS everywhere** | 3.1–3.3 ✅ (ADR 0070–0072) · **3.4 next** |
| 4. Automation engine | 4.1 seven more triggers · 4.2 AI decides · 4.3 Automation Library · **the rest** | 4.1–4.3 ✅ (ADR 0066–0068) · rest open |
| 5. Open platform | public API + webhooks, Outlook, Xero, CRM connectors | not started (Xero **pending**; CRM: only the one most target agencies use) |
| 6. Marketing | Marketing Studio → Social & Ads → Funnel Builder | not started; ads **pending** (the user, 2026-10-29) |
| 7. The rest | voice control, property management, recruitment, team workload | not started |

Also done outside the phases: **Skills default OFF + Workflow emails switch + pair skills** (ADR 0069),
**minute-tick batching for 50–100 agencies** (ADR 0073), **Cloudflare DNS cutover checklist**
(`docs/DNS-CUTOVER.md`) with `phone:repoint`. Whole platform ≈ **45%** (ROADMAP Part 1 has per-skill numbers).

### The Phone & SMS design in one paragraph (ADR 0070–0072)

Each agency brings its **own Twilio** (API key in Connectors → Phone & SMS, secret encrypted). Twilio checks the
business (AU KYC); then the owner gets each agent an **AU mobile number**. The agent verifies their own mobile
(Verified Caller ID) and turns on **Call Forwarding on No Answer** to that number, then a test call proves it. A
missed call reaches our voice webhook: kept, greeting played, and — only while the **pair skill** "Missed call text"
is on for the agency AND the agent — the owner's template text goes from the agent's number. The **AI call back**
(Retell, the platform's own account, one agent for all agencies) is scheduled in calling hours behind its own pair
skill, re-checked before it is placed (handled / texted back / switched off / STOP), and Retell's webhook brings back
transcript, recording and a labelled summary. Webhooks are authenticated by an HMAC token in the URL.

---

## 4. Database and migrations — exact state (important)

- **The dev database IS the production database** (Supabase, Sydney `ap-southeast-2`). Anything you run against
  `DATABASE_URL` touches live data. Use rolled-back transactions for experiments; smoke checks do this (`inRollback`).
- `drizzle.__drizzle_migrations`: **all 74 recorded (0000–0073)**, checked 2026-10-31. Nothing is pending (§1).
- The next migration is applied the normal way: a rolled-back dry run (§6), then
  `pnpm --filter @repo/db db:migrate` on the user's go. Afterwards check it is recorded (75 rows).
- **Never insert rows into `__drizzle_migrations` by hand:** drizzle runs only migrations newer than the newest
  recorded one, so a hand-recorded later migration makes it skip earlier ones forever.

## 5. Accounts, keys and environment

- `.env.local` files are NOT in git (root, `apps/console`, `apps/web`). Ask the user to copy them securely from the
  old laptop. The names are in `.env.example` (kept current).
- **Have:** Supabase (Pro), Vercel Pro, Anthropic, Resend, Google Cloud (Maps, OAuth app in Testing, Picker), Zoom
  developer app (only the developer's own account connects until Marketplace review).
- **Promised by the client, not yet given:** Voyage key (`EMBEDDINGS_PROVIDER=voyage` + `VOYAGE_API_KEY` → smart
  search; then run the backfill), Retell key, a test Twilio account (KYC approved), the **temporary domain** (real
  domain later). "Real keys testing" is **pending** by the user's choice.
- **Placeholders in `.env.local`:** `PHONE_STUB=1` (dev-only pretend Twilio + Retell; ignored in production),
  `PHONE_WEBHOOK_BASE`, `SMS_LIMIT_PER_AGENT_DAY`, `RETELL_API_KEY`, `RETELL_AGENT_ID`, `RETELL_VERIFY_SIGNATURE`,
  `EMBEDDINGS_PROVIDER`, `VOYAGE_API_KEY` — empty until the real values come.
- When Retell arrives: `RETELL_API_KEY=… PHONE_WEBHOOK_BASE=https://<web> pnpm --filter @repo/ai retell:setup` prints
  `RETELL_AGENT_ID`. Then owners press "Set up AI calls". Then walk TEST-PLAN BX, BY, BZ.
- **PROVISIONAL until real keys** (say so when asked): Retell request shapes, Retell signature check (off by default;
  the URL token is always checked), the Twilio Elastic SIP trunk calls, the agent's mobile as caller ID on AI calls
  (today AI calls come from the agent's Twilio number), carrier forwarding codes (`**61*…**20#`, `##61#`).

## 6. How to verify (what works on this setup)

- **Unit:** `pnpm --filter @repo/core test` (and `@repo/ai`). On Windows 3 tests always fail and are NOT yours:
  `isolation/entrypoints.test.ts` (2 — Windows `\` paths vs the `PUBLIC_ROUTES` keys) and
  `single-table-subquery.test.ts` (1 — `imports.ts` lines 630–632). Check new failures are not in those lists.
- **Typecheck:** `pnpm --filter @repo/core --filter @repo/db --filter @repo/ai --filter @repo/smoke --filter console --filter web typecheck`.
- **Lint:** `npx eslint <files>` inside `apps/console` / `apps/web`.
- **Break-test** every new guard (AGENTS.md): break it, see red, restore, see green.
- **Smoke against the real DB, rolled back:** `SMOKE_ENABLED=true SMOKE_ONLY="Phone & SMS" pnpm --filter @repo/smoke smoke`
  (3 checks; ~3–10 min from far away — run it in the background). Fixtures switch every skill on; a check that tests
  a default switches the skill off itself.
- **Do NOT call `/api/cron/minute` locally:** it runs every agency's workflows, emails and calls against the shared
  database with this branch's code. Call the single job you need from a small `tsx` script, filtered to one agency
  (e.g. `runDueAiCallbacks(db, stubVoiceAi(), date, 5, { agencyId })`).
- **Applying a migration by hand:** from `packages/db`, a node script with `postgres` + `dotenv` that reads the SQL
  file, splits on `--> statement-breakpoint`, runs all parts inside `sql.begin(...)`; run it twice to prove it is
  idempotent; check columns/RLS/grants; confirm `max(created_at)` in `drizzle.__drizzle_migrations` did not change.
- **Browser checks:** `pnpm dev` in `apps/console` (3001) and `apps/web` (3000); hosts `agency.lvh.me:3001`,
  `agents.lvh.me:3001`, `web.lvh.me:3000`. Headless Edge via `playwright-core` installed in a scratch folder (not the
  repo) with `chromium.launch({ channel: 'msedge' })`. Client-side navigations need `waitForURL`, not `networkidle`.
  Old `next dev` processes survive `TaskStop`; free ports 3000/3001 with `taskkill //PID <pid> //T //F`.

### The test agency (keep it; delete only right before go-live, after asking)

`phone-test-agency-20261030-dev` with owner `phone-test-owner-20261030@example.com` and agent
`phone-test-agent-20261030@example.com` (Supabase auth users, confirmed). Passwords were random and kept only on the
old laptop's scratch folder: on this laptop, set new ones with the Supabase admin API
(`PUT {SUPABASE_URL}/auth/v1/admin/users/{id}` with the service-role key) — never commit them. It holds stub Twilio
data (a connected account, Sam's number, texts, missed calls, one AI call).

---

## 7. What to do next, in order

1. **Tell the client** that every skill is off until an owner switches it on (§1). No migration decision is pending.
2. **Phase 3.4 — SMS everywhere** (plan below). Mock first.
3. **Phase 4 — the rest** (plan below). Mock first.
4. Meanwhile the user walks TEST-PLAN **BN–BZ** in a browser (they have not walked most of them).
5. When keys arrive: Voyage backfill; `retell:setup`; BX/BY/BZ with real Twilio + Retell; then switch
   `RETELL_VERIFY_SIGNATURE=1` once a real delivery verifies.
6. Go-live: `docs/DEPLOY.md` go-live checklist + `docs/DNS-CUTOVER.md` (temporary domain first); Google
   verification, Zoom Marketplace, privacy policy/terms text (lawyer), delete the test agency (ask first).
7. Phases 5–7, each starting with the user's decisions (which CRM, which property-data provider, Outlook first).

### Plan: Phase 3.4 — SMS everywhere (ROADMAP 3.4; #5, #8, #27)

Scope (each reuses Phone & SMS; nothing new from providers):
- **Matched buyers → "Text them"** on the listing's Matching buyers tab (ADR 0060 has "Email them" + a task): an
  approved SMS template, recipients frozen at Prepare, consent + STOP checked at send, from each buyer's agent's
  own number (or the person's own number — decide), daily limits.
- **Bulk SMS** beside Bulk email (ADR 0022 flow: template → filter → Prepare → Approve & Send, 48 h expiry).
- **Workflow action "Send SMS"**: an approved template to the run's contact, behind a skill (like `workflow_emails`;
  ask whether it should be a `pair` skill — it costs the agency per text), checked at run AND at step time
  (`SKILL_OF_WORKFLOW_STEP`).
- **Workflow trigger "Missed call"**: `recordMissedCall` emits `missed_call` (needs a migration widening
  `workflow_event_kind_check` again — 0074, idempotent; 0069 is already applied).
Rules that must hold: marketing SMS only to contacts with marketing consent (Spam Act) — a one-to-one reply in a
conversation is not marketing; never a STOP number; Australian mobiles only; ≤ 480 chars for templates; templates
are human-written (non-negotiable 7); limits per agent and agency per day; dev safety like `EMAIL_DEV_ALLOWLIST`
(an SMS allowlist outside production).
Questions to put to the user before the mock: SMS templates as a new table or `email_template` with a channel? Which
number sends a bulk SMS when the owner has none? Is "Send SMS" in workflows a pair skill?
Steps: mock `docs/mocks/sms-everywhere.html` → approval → ADR 0074 → migration 0074 → core (`phone/sms-batches.ts`,
workflow action + trigger) → console (Matching buyers, Bulk SMS page, workflow card words) → assistant tool words if
any → smoke check in "Phone & SMS" → TEST-PLAN CA → ROADMAP tick.

### Plan: Phase 4 — the rest (#27, #7)

From ROADMAP: more triggers (CRM, property, communication, calendar, transaction, missed call), the "AI understands →
decides" step beyond the first decision, more Automation Library templates, a **Control Centre** page (what ran,
what is waiting for approval, what failed — across workflows, skills and phone automations), and the **three
permission levels** (🟢 automatic / 🟡 needs approval / 🔴 human only) made explicit per automation in Skills. The
visual builder comes last. Mock first; the Control Centre is the biggest piece of UI.

---

## 8. Where things live (this period)

- Skills: `packages/core/src/skill-switches/` (`catalog.ts`: keys, groups, `pair`, `SKILL_OF_TOOL`,
  `SKILL_OF_WORKFLOW_STEP`; `switches.ts`: default-off, `isPairedSkillOn`), console `components/skills/`.
- Phone & SMS: `packages/core/src/phone/` — `twilio.ts` (client + stub), `format.ts` (numbers, forwarding codes,
  webhook token), `setup.ts` (connect, KYC, numbers, caller ID, test call, `repointNumberWebhooks`), `sms.ts`,
  `missed-calls.ts`, `voice.ts` (Retell client/stub, calling hours, decision, signature), `ai-callback.ts` (setup,
  tick, Retell webhook), `webhooks.ts` (Twilio). Prompt: `packages/ai/src/prompts/ai-callback-v1.ts`; setup CLI
  `packages/ai/src/retell/setup-cli.ts`. Console: `components/phone/`, pages `/settings/phone`, `/my-phone`,
  `/inbox/texts`, `/my-inbox/texts`, `/missed-calls(+/settings)`, `/my-missed-calls`. Web: `app/api/phone/twilio/[token]/[kind]`,
  `app/api/phone/retell/[token]`.
- Minute tick: `packages/core/src/cron/` (`tick.ts` runner, `minute-jobs.ts` list + `MINUTE_BATCH`), route
  `apps/web/app/api/cron/minute/route.ts` (deps only).
- Mocks: `docs/mocks/` (README lists each and its approval). Tests for the manual walk: `docs/TEST-PLAN.md` (BW skills
  default off, BX phone, BY missed calls, BZ AI call back).

## 9. Facts from the old laptop's memory (they do not travel with the repo)

- The user prefers Roman Urdu replies and confirmation of ambiguous asks.
- The client's roadmap and decisions are in `docs/ROADMAP.md` Part 3–4 (keep them there).
- Accounts plan (2026-10-29): the client gives the temporary domain, Voyage, Retell and a test Twilio; Vercel Pro
  and Supabase Pro exist; Twilio is bring-your-own per agency; Xero, Stripe (platform billing) and ads are pending.
- Migrations: all 74 applied and recorded (§1, §4); the test agency as in §6.
- Do not change the email sender domain.
