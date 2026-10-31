# Handoff — updated 2026-10-31 (for whichever Claude picks this up, on either laptop)

This file is everything you need that is not obvious from the code. Read it fully once, then follow §7 "What to do
next". Keep it current, or replace it with your own at your handoff.

---

## 0. Read in this order

1. This file.
2. `AGENTS.md` (via `CLAUDE.md`) — the domain law: 14 non-negotiables (property ≠ listing, `can()` only, LLM only
   in `packages/ai`, the LLM never produces a number, AI listing copy is a draft, no business logic in `apps/`…).
3. `ARCHITECTURE.md` — how the app is built (rendering, data fetching, verification discipline).
4. `docs/ROADMAP.md` — the client's 28 skills (Part 4 = the brief, nothing dropped), status (Part 1), the work
   order (Part 3), version 1 / version 2, technical debt.
5. `docs/STATUS.md` top entries and `docs/SESSION.md` top entry.
6. The ADR of whatever you touch (`docs/adr/`; 0057–0075 are this period's).

---

## 1. Where things stand (2026-10-31)

- **`main` = `a8b3b89`**, pushed and deployed (the user verified web and console live after `206f30c`).
- **Database: 77 migrations recorded (0000–0076). Nothing pending.** Both laptops use the same `DATABASE_URL`.
- **Every skill is OFF until someone switches it on** (ADR 0069, the client's decision). Only "Missed call text" and
  "AI call back" are on (the phone test agency). Owners switch on the rest under Skills; tell agencies this.
- **Waiting on the client** (the user is chasing): approval of two mocks, shared as private Artifacts —
  SMS rules (5 decisions) `https://claude.ai/artifact/74QvqkPBjaLQSKnXCv5NE2` (`docs/mocks/sms-everywhere.html`) and
  Control Centre (4 decisions) `https://claude.ai/artifact/7FwmtFRuuNxLo2TNYhLQDh` (`docs/mocks/control-centre.html`);
  the keys (Twilio test account with KYC, Retell, Voyage) and the temporary domain.

---

## 2. The user and how to work with them

- **The user writes typo-heavy Roman Urdu. Reply in Roman Urdu** (English for code, docs, commits). When an ask is
  ambiguous, confirm before acting. They often paste messages written by/for their **boss (the client)** — those
  are the user's requests.
- **The client = the boss / project owner** who provides accounts and approves mocks. Not the end users.
- **Process for every feature:** HTML mock in `docs/mocks/` → the client approves → ADR in `docs/adr/` (short) →
  code (contract/types first) → TEST-PLAN section → tick ROADMAP. Mock first for any new UI. A mock for the client
  also goes up as a private Artifact (the user shares it).
- **Never without the user's explicit go:** applying a migration, pushing, merging, deploying, deleting data,
  sending anything to real people, running smoke (slow). A "theek hai" on a mock is the mock's approval only.
- **Migrations, the way that worked:** a rolled-back dry run first (the SQL twice in one transaction — idempotent —
  plus checks of what it should allow and refuse), then `pnpm --filter @repo/db db:migrate` on the go, then check
  the row count. **Code that needs a migration ships only after it is applied** (0069 and 0074 taught this); a
  change that old code cannot survive is split (0075 added, the code deployed, then 0076 dropped).
- **Branches:** work on a feature branch; `main` is checked out in another worktree (`../realestate_ai-crm2`, with
  an uncommitted `pnpm-lock.yaml` there), so merge by a fast-forward push: `git push origin <branch>:main`.
- **Commits:** end messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. One commit per step.
  Never commit `apps/*/next-env.d.ts` changes. `packages/smoke/src/test-accounts.ts` is git-ignored (it holds a
  password) — keep it local.
- **Email sender stays `alerts@quotemydecking.com.au`** (Resend-verified). Never propose changing it.
- **The user wants proof, not claims:** say what you ran and what it printed; say plainly what you did not test.

---

## 3. The roadmap — what is done, what is left

**Version 2, not now (the user, 2026-10-31):** Phase 6 Marketing (Studio, Social & Ads, Funnel Builder), Xero, CRM
connectors. Everything else is version 1.

| Phase | Done | Left (version 1) |
|---|---|---|
| 1. Finish what is half built | 1.1–1.6 ✅ (ADR 0057–0062) | — |
| 2. Money | 2.1–2.3 ✅ (ADR 0063–0065) | — |
| 3. Phone + SMS | 3.1–3.3 ✅ on the stub (ADR 0070–0072); 3.4 part 1 ✅ (ADR 0074: templates by channel, `call.missed`) | 3.4 part 2 — waits for the client's 5 SMS rules |
| 4. Automation engine | 4.1–4.3 ✅ (ADR 0066–0068) | 4.4 more triggers · 4.5 AI decides beyond the first step · 4.6/4.7 Control Centre + permission levels (wait for the client's 4 decisions) · 4.8 visual builder (last) |
| 5. Open platform | — | 5.1 public API + webhooks (the user's decisions first) · 5.2 Outlook |
| 7. The rest | — | voice control · Property Management · recruitment + training · team workload board (mock each) |

Also done: Skills default off (ADR 0069), minute-tick batching (ADR 0073), DNS cutover checklist, and the
**technical debt fixed by ADR 0075** — one address, several agencies (§4).

### The Phone & SMS design in one paragraph (ADR 0070–0072)

Each agency brings its **own Twilio** (API key in Connectors → Phone & SMS, secret encrypted). Twilio checks the
business (AU KYC); then the owner gets each agent an **AU mobile number**. The agent verifies their own mobile
(Verified Caller ID) and turns on **Call Forwarding on No Answer** to that number, then a test call proves it. A
missed call reaches our voice webhook: kept, greeting played, and — only while the **pair skill** "Missed call text"
is on for the agency AND the agent — the owner's template text goes from the agent's number. The **AI call back**
(Retell, the platform's own account) is scheduled in calling hours behind its own pair skill, re-checked before it is
placed, and Retell's webhook brings back transcript, recording and a labelled summary. Since ADR 0074 a missed call
also emits the workflow trigger `call.missed`.

### Phase 3.4 part 2 (after the client's rules)

The user decided (2026-10-31): SMS templates are `email_template` rows with `channel = 'sms'` (built); a text goes
from the contact's assigned agent's Twilio number, else the agency number (the agency number does not exist yet —
mock proposes the owner picks one of the agency's numbers); the workflow step "Send SMS" (`send_template_sms`) is a
pair skill "Workflow texts". The client decides: the agency number, consent (proposed: the Bulk email rule), sending
hours (9–8), one automatic text per caller per 24 h, 100 texts per number per day. Then: Bulk SMS batches, "Text
them" on Matching buyers, the step, the SMS template editor; the rules at prepare and again at send.

---

## 4. Database and migrations

- **The dev database IS the production database** (Supabase, Sydney). Anything you run against `DATABASE_URL`
  touches live data. Use rolled-back transactions for experiments; smoke checks do this (`inRollback`).
- 77 recorded (0000–0076). 0074: `email_template.channel` + `call.missed`. 0075: the listing's own facts (seven
  columns, backfilled) + `deal_open_agency_property_idx`. 0076: the old one-deal-per-address index dropped.
- **ADR 0075 in one line:** `property` is one shared row per address; a listing never rewrites it (facts only
  filled where empty, the pin moved only when no other agency uses the address); each ad's facts live on the
  listing and every read goes through `listings/facts.ts` (`coalesce(listing.x, property.x)`); deals are per agency.
  A unit test scans core for any read of a fact straight off `property` — keep it green.
- **Never insert rows into `__drizzle_migrations` by hand.**

## 5. Accounts, keys and environment

- `.env.local` files are NOT in git (root, `apps/console`, `apps/web`). Copy them securely between laptops.
- **Have:** Supabase (Pro), Vercel Pro, Anthropic, Resend, Google Cloud (Maps, OAuth app in Testing, Picker), Zoom
  developer app (only the developer's own account connects until Marketplace review).
- **Promised by the client, not yet given:** Voyage key (`EMBEDDINGS_PROVIDER=voyage` + `VOYAGE_API_KEY`, then the
  backfill), Retell key, a test Twilio account (KYC approved), the temporary domain.
- **Placeholders in `.env.local`:** `PHONE_STUB=1` (dev-only pretend Twilio + Retell; ignored in production),
  `PHONE_WEBHOOK_BASE`, `SMS_LIMIT_PER_AGENT_DAY`, `RETELL_API_KEY`, `RETELL_AGENT_ID`, `RETELL_VERIFY_SIGNATURE`,
  `EMBEDDINGS_PROVIDER`, `VOYAGE_API_KEY`.
- When Retell arrives: `RETELL_API_KEY=… PHONE_WEBHOOK_BASE=https://<web> pnpm --filter @repo/ai retell:setup` prints
  `RETELL_AGENT_ID`. Then owners press "Set up AI calls". Then walk TEST-PLAN BX, BY, BZ.
- **PROVISIONAL until real keys:** Retell request shapes, Retell signature check, the Twilio Elastic SIP trunk calls,
  the agent's mobile as caller ID on AI calls, carrier forwarding codes.

## 6. How to verify

- **Unit:** `pnpm test` (offline, free). On the Mac everything passes (core 1498, ai 331 at `a8b3b89`). On Windows 3
  tests always fail and are not yours (`isolation/entrypoints.test.ts` ×2, `single-table-subquery.test.ts` ×1).
- **Typecheck:** `pnpm --filter @repo/core --filter @repo/db --filter @repo/ai --filter @repo/smoke --filter console --filter web typecheck`.
- **Break-test** every new guard: break it, see red, restore, see green.
- **Smoke, one group, in the background, on the user's go:** `SMOKE_ENABLED=true SMOKE_ONLY="<group>" pnpm --filter @repo/smoke smoke`.
  "Tenant isolation" on 2026-10-31: **5/5 green** (incl. the ADR 0075 check; "tokens and the sync job" fixed — its
  agents now connect their own Zoom, as the rule since 2026-10-22 `f7cbc4d` requires).
- **Do NOT call `/api/cron/minute` locally:** it runs every agency's jobs against the shared database. Call one job
  from a `tsx` script filtered to one agency — e.g. `packages/smoke/src/sync-test-deals.ts` (`runDealSync(db, { agencyId })`).
- **Browser checks:** `pnpm dev` in `apps/console` (3001) and `apps/web` (3000); hosts `agency.lvh.me:3001`,
  `agents.lvh.me:3001`, `web.lvh.me:3000`.

### The phone test agency (keep it; delete only right before go-live, after asking)

`phone-test-agency-20261030-dev`, owner `phone-test-owner-20261030@example.com`, agent
`phone-test-agent-20261030@example.com`. Passwords: reset 2026-10-31 with the Supabase admin API and given to the
user, never committed — reset again the same way if needed (`PUT {SUPABASE_URL}/auth/v1/admin/users/{id}`).
Seeded by `packages/smoke/src/seed-phone-test-agency.ts` (idempotent; tester-alias emails
`alphaedgetechnologylabs+pt-…@gmail.com`, ACMA fictional numbers 0491 570 xxx, MADE-UP addresses only — it refuses
an address any property row already has): listings 1 Testing Way (live), 14 Station St (live), 8 Rosewood Ct
(draft); contacts Amira (consent + brief), Ben (brief), Chloe (unsubscribed), Owen (owner of 1 Testing Way), Priya
(past client), Ella (enquiry); an appraisal; an agency template; deals on all three. The agent has no agent
profile — set the 60/40 split in Agents & Team before BR. Never seed at a real address: once a test listing at
27 Lakeside Blvd rewrote agency Alpha's property (Alpha is the user's own; they fix its pin in the UI).

---

## 7. What to do next, in order (the user's order, 2026-10-31)

1. **Phase 4.4 — more triggers: mock** (`docs/mocks/`), so the client reviews it with the SMS and Control Centre
   mocks. Then ADR, code, TEST-PLAN.
2. When the client answers: **3.4 part 2** (§3), then **4.6/4.7 Control Centre**.
3. Meanwhile, not waiting on anyone: 4.5, 5.2 Outlook, the Phase 7 mocks; 5.1 after the user's API decisions.
4. When keys arrive: Voyage backfill; `retell:setup`; BX/BY/BZ with real Twilio + Retell.
5. At the very end the user walks the browser tests: TEST-PLAN **BN–BZ, CA, CB**.
6. Go-live: `docs/DEPLOY.md` + `docs/DNS-CUTOVER.md`; Google verification, Zoom Marketplace, privacy policy/terms
   (lawyer), delete the test agencies (ask first).

---

## 8. Where things live (this period)

- Skills: `packages/core/src/skill-switches/` (`catalog.ts`, `switches.ts`), console `components/skills/`.
- Phone & SMS: `packages/core/src/phone/` (`twilio.ts`, `format.ts`, `setup.ts`, `sms.ts`, `missed-calls.ts` — emits
  `call.missed`, `voice.ts`, `ai-callback.ts`, `webhooks.ts`). Console `components/phone/`.
- Templates: `packages/core/src/template-email/` — `templates.ts` (`mayUseTemplate` / `usableTemplateSql` /
  `listTemplates` take a channel, default email), `sms.ts` (480 chars, STOP footer, `smsParts`).
- Workflows: `packages/core/src/workflows/` (`catalog.ts` triggers incl. `call.missed`, `engine.ts`, `scans.ts`).
- Property facts: `packages/core/src/listings/facts.ts` (+ `facts.test.ts`, the guard); `property-resolver.ts`
  (`upsertProperty`, `usedByAnotherAgency`). Deals: `packages/core/src/deals/sync.ts` (per agency; `{ agencyId }`).
- Minute tick: `packages/core/src/cron/`, route `apps/web/app/api/cron/minute/route.ts`.
- Mocks: `docs/mocks/` (README lists each and its approval). Manual tests: `docs/TEST-PLAN.md`.

## 9. Facts the repo does not carry

- The user prefers Roman Urdu replies and confirmation of ambiguous asks.
- Accounts plan (2026-10-29): the client gives the temporary domain, Voyage, Retell and a test Twilio; Twilio is
  bring-your-own per agency; Xero, Stripe (platform billing) and ads are pending / version 2.
- Agency "Alpha" (owner `saad.swl786@gmail.com`) is the user's own dev agency.
- Do not change the email sender domain.
