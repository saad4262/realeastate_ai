# Platform plan — final

Written 2026-11-14, from the code, `docs/STATUS.md`, the ADRs (0001–0090), `ARCHITECTURE.md`,
`docs/ROADMAP.md` and the hardening plan (2026-10-30, revised 2026-11-02).

**Who reads this:** the two developers, and the boss for sections 12–15. It is the one plan for how the
platform grows: versions, scale, speed, reliability, security, privacy, compatibility, flows, limits,
cost and pricing. Feature work stays in `docs/ROADMAP.md`. Task numbers (0.1 … 5.10) are the
tables in section 14; labels such as D1, D2, P1 come from the retired hardening plan.

Marks: ✅ built · 🟡 partly built · ❌ not built · **(est.)** an estimate, not a measurement.
Prices are in USD unless marked A$. The conversion assumes **1 USD = A$1.55** (check the rate on the
day). Customer prices are quoted without GST (add 10%). Change a decision in this file only with an
ADR.

---

## Contents
1. Where we are today
2. The decisions (stack and rules)
3. The versions
4. Scalability
5. Speed
6. Reliability and backups
7. Security
8. Privacy and Australian law
9. Compatibility
10. The flows
11. Limits
12. Cost
13. Pricing: three plans with AI credits
14. Order of work: the to-do list, steps 0–27, with progress
15. Decisions
16. Risks
Appendix: unit prices and sources

---

## 1. Where we are today

### The product
Two Next.js apps, one `packages/` layer, one database (ADR 0002):

| Surface | Host | What it is |
|---|---|---|
| Public site (`apps/web`) | site.com.au | Search, listings, property pages, buyer accounts, alerts, the property chat, consumer skills (ADR 0080) |
| Agent console (`apps/console`) | agents.* | CRM, listings, inbox, the AI assistant and skill chats, automations, documents, dashboards, phone and SMS |
| Agency console | agency.* | The same app for owners and admins: team, agency settings, skills control centre, reports |
| Platform admin | admin.* | Read-only platform view (ADR 0049–0052), agency control, the AI cost page (ADR 0086) |

### Built, by area (ADR numbers)

| Area | Built |
|---|---|
| Accounts | Supabase Auth with local session check (0004, 0046); invites and self-serve sign-up (0005, 0006); roles through `can()`; team editing (0033) |
| Listings | Property ≠ listing; shared property per address (0075); history (0013); CSV and Google Sheets import (0024, 0029); approval before publish (0014); property page (0065) |
| CRM | One person, many roles (0018, 0061); customer profile across channels (0083); same email updates the profile (0079, 0084); AI import (0056); buyer requirements and matching (0055, 0059, 0060); deals and commissions (0063, 0064) |
| Communication | Email inside the app (0016), Gmail and Outlook (0026, 0076), bulk email, templates (0043), SMS everywhere (0074), missed-call text (0071), AI call-back through Retell (0072), Twilio per agent and hybrid (0087, 0090) |
| AI | Assistant with tools (0025, 0039–0041), three kinds of chat (0088), skills as prompts over fixed handlers (0021), skill switches default off (0069), AI reads enquiries (0078), documents and knowledge base (0053), dashboards in words (0027, 0036, 0044, 0047), open questions on agency data (0042), meaning-based search (0031, off) |
| Automation | Workflows and triggers (0048, 0066–0068), automations as what people set up (0089), opportunities (0054), no reply after 6 hours (0085), minute tick with rounds and a budget (0073) |
| Platform | Platform admin (0049–0052), agency control, AI cost page (0086), Sentry wiring (0082), legal pages (0037) |

**Size:** 98 tables, 97 migrations, about 2,200 core unit tests and 460 AI unit tests, plus `pnpm smoke`.

### Live state (STATUS 2026-11-09)
- Deployed on Vercel at `vercel.app` addresses. The `findoraaus.com.au` DNS is not answering yet.
- **One database (`xjklpoyxcvnlhjlxasmv`, Sydney), and it is production.** `.env.local` points at it.
  There is no dev database and no production guard.
- The AI platform cap is $20 a day. Sentry is wired but has no DSN. Twilio has been tested only with
  test credentials.
- No real agencies yet. The listings are test data.

---

## 2. The decisions

### Stack (final)

| Layer | Decision | Status |
|---|---|---|
| Apps | Next.js 15.5.x App Router, React 19, two apps, Turborepo + pnpm, TypeScript strict, Node 22 | ✅ |
| Hosting | Vercel Pro, `syd1`, Fluid compute | ✅ |
| Database | Supabase Postgres 17 (Sydney) + PostGIS + pgvector, Drizzle, postgres.js through the transaction pooler | ✅. ❌ dev database, guard, `max: 2` + timeouts |
| Auth | Supabase Auth, `getClaims()` checked locally, roles in our DB through `can()` | ✅. ❌ signed session header, MFA, 503 on outage |
| Files | Supabase Storage now (photos, documents); Cloudflare R2 for photos at V2 | 🟡: photos kept as uploaded (10 MB max), no variants |
| Background work | Our own Postgres jobs: `SKIP LOCKED` claims, outbox (`workflow_event`), minute tick (ADR 0073). Next: one `job` table with retries, backoff, dead-letter and per-agency fairness | 🟡: patterns in 14 modules, no `job` table |
| Rate limits | Upstash Redis (Sydney), in-memory fallback | ❌ in-memory per instance only |
| Push to the console | 5 s poll now; Supabase Realtime "something changed" nudge at V3 | 🟡 |
| Errors | Sentry, both apps | 🟡 no DSN |
| Uptime | `/api/health` + uptime monitor + healthchecks.io dead-man | ❌ |
| Edge | Cloudflare DNS only (grey cloud) + Turnstile; Vercel Firewall | ❌ DNS pending |
| Backups | PITR + encrypted `pg_dump` to S3 Melbourne (Object Lock, separate account) + daily file sync + monthly restore drill | ❌ (Supabase's own only) |
| CI | GitHub Actions: frozen install, typecheck, lint, test, `pnpm audit` | 🟡: no branch protection, gitleaks, Dependabot |
| AI | Anthropic only through `packages/ai`, every call metered in `ai_run`; Voyage embeddings (off) | ✅ |
| Billing | Stripe: three plans + AI credits (section 13) | ❌ |
| Email / phone / meetings / maps | Resend, Twilio (agency's own or managed subaccount), Retell, Zoom, Google | ✅ |

**Not adding:** Kafka, Redis as a data cache, microservices, Kubernetes, a separate search engine,
Datadog-class APM, GraphQL. **Only on a trigger (section 4):** read replica, R2, cells, Aurora,
Fargate workers, Amazon SES, Cloudflare Workers.

### The rules

These come from CLAUDE.md and the hardening plan, and every change keeps them.

1. **Modular monolith.** Business logic lives in `packages/core`; there is nothing in `apps/`.
2. **The server is the only door** to the database (ADR 0017). Identity that crosses from middleware
   is signed (1.1).
3. **Every row is agency-scoped.** `can()` plus scope helpers everywhere. Cross-agency reads exist only
   in the public read model and the platform admin.
4. **Anything slow or external is a job.** Webhooks answer in about a second, and no network call
   happens inside a transaction.
5. **Push, not poll**, from V3.
6. **Caching:** a CDN or ISR only for public pages. Private data never sits in a shared cache.
7. **Fail soft:** pause background work first, then shed polls with a 503. Never drop a write. An auth
   check that cannot run is a 503, not a sign-out.
8. **Every resource has a budget:** rate limits, per-agency caps, AI credits, and hard spend stops at
   every vendor.
9. **Data lifecycle:** soft delete → trash → purge, retention periods, imports that can be undone.
10. **Backups are 3-2-1 and proven** by a monthly restore drill.
11. **Least privilege:** MFA for owners and admins. Claude never holds production keys. Production
    changes need the other developer.
12. **Observable by default.** Alerts exist only for things that need someone to act.
13. **Platform-neutral code:** vendor SDKs stay inside small adapters.
14. **Delivery:** branch → PR → CI → review → merge. Migrations go expand, then contract, with a lock of
    at most one second.
15. **Data is sized on purpose:** blobs in object storage, photos as variants, logs purged by
    partition, time-ordered ids.
16. **The LLM never produces a number.** AI listing copy is always a draft. Every model call goes through
    `usage.ts` into `ai_run` (CLAUDE.md #3, #4, #7).

---

## 3. The versions

| Version | Agencies | Agents (seats) | Users (public accounts) |
|---|---|---|---|
| **V1** | 200 | 500 | 2,000 |
| **V2** | 500 | 1,000 | 5,000 |
| **V3** | 1,000 | 2,000 | 10,000 |
| V4, V5 … | ×2 each step | ×2 | ×2 |

**V4 and beyond:** AI, email, SMS and maps double each step. The database moves up one compute size
per version. At about 1,500 agencies we split into cells (section 4).

**Build for the next version.** While V1 is live, everything must already pass a load test at V2's
numbers.

### What each version carries (est.)

| | V1 | V2 | V3 |
|---|---|---|---|
| Console tabs open at peak | 250–500 | 500–1,000 | 1,000–2,000 |
| `/api/live` (5 s poll) | 50–100 req/s | 100–200 req/s | 200–400 req/s |
| Contacts | 1–2M | 2.5–5M | 5–10M (worst case 50M) |
| Active listings | 6,000 | 15,000 | 30,000 |
| Public listing views a month | 1.8M | 4.5M | 9M |
| Database at year end | 10–40 GB | 25–80 GB | 50–150 GB |
| Photos (as uploaded / as variants) | 0.5 TB / 50 GB | 1.2 TB / 120 GB | 2.5 TB / 250 GB |
| Emails a month | ~220k | ~450k | ~900k |
| AI questions a working day | 5,000 | 10,000 | 20,000 |

---

## 4. Scalability

### Build once, scale by a setting
Moving up a version should mean changing env values and one compute size, not code. That holds only
when these exist:

| # | What | Hardening step | Status |
|---|---|---|---|
| 1 | Dev and production databases; DB scripts refuse production without `CONFIRM_PRODUCTION=<host>` | 0.1, 0.2 | ❌ |
| 2 | Every cap is an env value with a default (most are: `EMAIL_LIMIT_*`, `AI_DAILY_BUDGET_*`) | — | 🟡 |
| 3 | One shared rate limiter (Upstash, keys per IP, user and agency) | 1.4 | ❌ |
| 4 | DB connection budget: `max: 2` per instance (today 10), timeouts, `statement_timeout` per role | 3.3, 3.14 | ❌ |
| 5 | `job` table: webhooks first, then imports and sends | 7.2, 3.10 | ❌ |
| 6 | Usage per agency per day (AI, emails, SMS, minutes, import rows, storage) | new | 🟡: AI only, in `ai_run` |
| 7 | Photos as variants behind a storage adapter, so R2 is a config change | D2 | ❌ |
| 8 | Agency-scoped queries, guarded by the isolation test (cells later) | 3.9 | 🟡 |
| 9 | Data layout while it is cheap: FK indexes, UUIDv7, lz4, `pg_trgm` | D1, P1–P3 | ❌ |
| 10 | One k6 load-test script with V1, V2 and V3 profiles, 60 minutes, on a seeded dev database | 3.6 | ❌ |

### Infrastructure per version

| | V1 | V2 | V3 |
|---|---|---|---|
| Supabase | Pro, **Medium** at launch → **Large** (8 GB, 800 pooler clients) before ~100 agencies | Pro, **XL** (16 GB, 1,000) | Pro, **2XL** (32 GB, 1,500) + **read replica** |
| PITR | off for now (decision 7); 7 days once on | 14 days | 14 days |
| Dev database | Micro | Micro | Micro |
| Photos served from | Supabase via `next/image`, as variants | **R2 + CDN** | R2 |
| Console updates | 5 s poll | 5 s poll | **Realtime push** (3.8) |
| Background work | `job` table on the minute tick | same | separate worker routes if one job crowds the rest |
| Search | Postgres + `pg_trgm` | + keyset paging on public search (P5) | + replica for reports and AI reads |
| Logs | Batched purge | Monthly partitions for the two biggest (D3) | All log tables partitioned |
| People | 2 developers | + part-time support | + on-call rota |

A compute change restarts the database for a few minutes: do it at night, and announce it.

### When to move up
Move when any one of these is true:
- 80% of the version's agency count is reached.
- DB CPU p95 above 60% for 7 days, or the cache hit ratio below 99%.
- Pooler connections or disk above 70%.
- Console p95 over its budget (section 5) for a week.
- Vercel bandwidth above $500 a month (the R2 trigger).

Each move:
1. Load test at the next version.
2. Finish that version's steps (section 14.10).
3. Raise the compute size at night.
4. Copy the caps in section 11 into env.
5. Check vendor ceilings: Anthropic rate tier, Resend tier, Google quotas, Twilio limits.
6. Re-check costs against the real bills and re-price if needed.

### After V3
- **Cells at about 1,500 agencies:** agencies are split across several database stacks, with a small
  directory mapping agency → cell, and one global listings index fed by outbox events.
- **Supabase HA:** confirm automatic failover and its recovery time at V2. If it is not available,
  plan Aurora Multi-AZ before V3.

---

## 5. Speed

### Already fast (keep it so)
- Server Components by default; client islands only where needed (ARCHITECTURE §2).
- `getClaims()` checks the session locally, with no Auth round trip (ADR 0046).
- ISR on public pages; prefetch is targeted; navigation never reloads the page.
- Fonts are self-hosted; Material Symbols trimmed by 2.9 MB.
- Totals come from SQL in the same statement. `query-count.test.ts` catches an N+1.
- Bundle budgets exist (ARCHITECTURE §11): web shared 106 kB, `/listing/[id]` 124 kB, console shared
  107 kB.

### Targets (to be measured in the load test, for each version)

| What | Target p95 |
|---|---|
| Public listing page (ISR hit) | < 200 ms TTFB |
| Public search | < 500 ms |
| Console page navigation | < 800 ms |
| `/api/live` | < 100 ms |
| Assistant first visible token | < 3 s |
| A webhook's 200 | < 1 s |
| Import of 10,000 contacts, unattended | < 15 min |
| A change showing in another open tab | ≤ 5 s with polling, ≤ 2 s with push |

### Known slow paths and when they are fixed

| Slow path | Fix | When |
|---|---|---|
| 12 `ILIKE '%…%'` searches scan the whole agency | `pg_trgm` + GIN (P3) | Before the first agency |
| Random UUIDv4 inserts bloat indexes | UUIDv7 for new rows (P1) | Before the first agency |
| 126 foreign keys have no index | Index the ~35 hot ones (D1) | Before the first agency |
| Imports: 100 rows a chunk, a few chunks per tick | Run for 45 s a minute, 1,000-row inserts (3.10 b) | During V1 |
| Photos served as uploaded (up to 10 MB) | Resize in the browser now; variants (D2) | Before the first agency / V2 |
| Deep `OFFSET` on public search | Capped total, keyset "load more" (P5) | Before V2 |
| Dashboards recount on every read | Rollups kept by jobs (P7) | Before V2 |
| 5 s poll from every tab | Realtime nudge (3.8) | Before V3 |
| `/listing/<unknown>` returns 200 (soft 404) | ARCHITECTURE §14 | When the route is next touched |

---

## 6. Reliability and backups

### Already built
- The minute tick runs its jobs in rounds against a 45 s budget, with claims per row (ADR 0073).
- `SKIP LOCKED` claims and the outbox (`workflow_event`), so a crash re-runs work rather than losing it.
- Multi-step writes are in a transaction; network calls stay outside them (CLAUDE.md).
- Every AI call is capped (`checkAiBudget`), and smoke has fail-closed checks.
- Integration tokens are encrypted with key rotation (ADR 0020).

### Recovery targets

| | V1 | V2 | V3 |
|---|---|---|---|
| **RPO** (data we may lose) | ≤ 5 min with PITR (off for now: until then ≤ 24 h from the daily backup, ≤ 6 h once 0.4 runs); ≤ 6 h if the Supabase account is lost (S3 dump) | same | same, daily dump once above 200 GB |
| **RTO** (time to come back) | 4 h | 2 h | 1 h (HA confirmed at V2) |
| Restore drill | Monthly, automatic (2.4) | same | same |
| Restore one agency | By runbook | By runbook | By script (2.5) |

### Gaps, in order
1. **Auth outage = everyone signed out.** `packages/auth/src/middleware.ts:131` treats any `getClaims`
   error as "no user". Fix: 503 + `Retry-After` (1.9).
2. **Backups:** PITR, `pg_dump` every 6 h encrypted to S3 Melbourne (Object Lock), daily file sync, a
   healthchecks.io dead-man (2.1–2.3).
3. **`/api/health`**, an uptime monitor, Sentry DSN, and these alerts: connections, disk, cron late,
   backup age, 5xx rate, transaction-ID age (3.4, 3.5, 3.16).
4. **`job` table:** retries with backoff and a dead-letter state. Webhooks answer in about 1 s (7.2).
5. **SMS 9 am rush:** today ~100 texts a minute platform-wide; at V1 a morning of held batches could
   take ~16 hours. Make it a drain job, fair per agency (3.2).
6. **When a provider is down:** AI down → a template, and the lead shows "AI was unavailable" (3.17);
   Twilio down → email the agent; email retries with backoff (3.7, 7.7).
7. **Imports never start automations**, and scans are incremental, so day 91 after a big import does
   not turn everyone "cold" at once (3.12, 3.13).
8. **Runbooks** (4.1): app crash → rollback · DB down / restore · key leaked · breach (NDB) · bot flood
   · AI bill spike · provider down · lost account access. Plus a secrets inventory with expiry dates;
   the Microsoft Entra secret expires (4.2).

---

## 7. Security

### Already built
- No browser access to tables; RLS on with no grants (ADR 0017; smoke "Database").
- `can()` on every action, permission tests, tenant-isolation smoke (ADR 0030).
- Middleware strips identity headers before any branching; a forged-header smoke check exists.
- Security headers on every response; CSP enforced where it cannot break a page (`4af8115`).
- Encrypted integration tokens with rotation; document downloads behind permission and 60 s signed links.
- Zoom and Resend webhooks verified; Twilio URLs carry an HMAC token only the server can make.
- AI caps on every model call, the public site included (`1ce1979`).

### To do, with when

| Step | What | When |
|---|---|---|
| 0.1, 0.2 | Dev database; the production guard; Claude keeps no production keys | Before the first agency |
| 0.4, 0.5 | Frozen install in CI, branch protection, gitleaks, Dependabot, `pnpm audit` | Before the first agency |
| 1.1 | **Signed session header** (HMAC + expiry). Today the header is unsigned and safe only while middleware always runs (CVE-2025-29927 showed it can be skipped) | Before the first agency |
| 1.2, 1.3 | **MFA** (TOTP) for owners, admins and platform admins; admin session cap, optional IP allowlist | Before the first agency |
| 1.7 | 15-minute JWT; "Sign out of all devices" | Before the first agency |
| 7.1 | **Retell signature on by default** (today off unless `RETELL_VERIFY_SIGNATURE=1`, `voice.ts:87`) | Before the first agency |
| 3.16 | **Hard spend stops**: Vercel, Anthropic console, Google quotas, Twilio triggers, Retell minutes | Before the first agency |
| 1.4, 1.5 | Upstash rate limits; Turnstile on sign-up, login and reset | During V1 |
| 1.8 | Route audit (every handler listed as authed or public) + an OWASP ZAP scan | Before V2 |
| 7.4 | Spend cap per Twilio subaccount; Australian destinations only | Before V2, or as soon as managed Twilio sells |
| Billing | Stripe webhooks: signature checked, event id stored once, owner-only purchase with a permission test | With Stripe |
| — | Paid penetration test | First large agency or first real revenue |

---

## 8. Privacy and Australian law

### What we hold
Agencies' contacts (names, emails, phones, addresses, notes), buyers' accounts and searches, listing
activity, emails and texts, documents, AI prompts and answers, and later call recordings.

### Where it goes

| Where | What | Status |
|---|---|---|
| Supabase (Sydney) | Everything at rest | ✅ in Australia |
| Vercel (`syd1` functions, global CDN) | Requests in flight, public pages | ✅ |
| Anthropic (US; `inference_geo` is global or US only) | Prompts and context for AI features | Overseas: name it in the privacy policy |
| Resend, Sentry, Google, Zoom, Twilio, Retell, Voyage | Their own parts | Overseas: name each. Check each one's data region, and turn Sentry's PII scrubbing on |

### To do

| What | Why | When |
|---|---|---|
| **The privacy policy names every overseas sub-processor and the retention periods** | APP 8, APP 11 | Before the first agency |
| **Listing activity names signed-in viewers to agencies** (ADR 0083): say so in the policy, or turn it off | APP 5, APP 6; parked for testing only (STATUS) | Before the first agency |
| Photos stripped of EXIF/GPS (browser resize now, server for imports) | A phone photo can give away a home address | Before the first agency / during V1 |
| Sign-up email confirmation on; real sender name and postal address | Spam Act; placeholders today (STATUS) | Before the first agency |
| Retention: trash 60 days, `site_activity` 13 months, AI prompts 90 days, an agency that leaves deleted 30 days after it leaves (decision 4); the agencies' own data otherwise kept while the account is active | APP 11.2 | During V1 |
| Agency data export (2.9); a person's access request answered from it | APP 12 | During V1 |
| Breach runbook: contain, assess within 30 days, the boss notifies the OAIC (NDB) | Notifiable Data Breaches scheme | Before the first agency |
| SMS: consent, sender identity, `STOP` (✅ in code); sender ID on the ACMA register | Spam Act; ACMA register since 1 July 2026 | Before SMS sells |
| Calls: Telemarketing Standard hours, Do Not Call Register wash, "this is an AI", recording consent per state (a lawyer confirms) | Telemarketing Standard, state recording laws | Before voice AI sells (7.5) |
| Recordings and transcripts: private bucket, `can()`, 90-day retention, the vendor's own copy off | Most personal data we will hold | Before voice AI sells (7.6) |
| Model-written text that reaches a third party needs a human; anything the person asked for carries a label | CLAUDE.md #7 | ✅ rule in place |

---

## 9. Compatibility

| Area | Supported | Rule |
|---|---|---|
| Runtime | Node 22, Next.js 15.5.28 (pinned exactly), React 19, Postgres 17, Drizzle 0.38, `@supabase/ssr` 0.12 | Verify fast-moving APIs with Context7. Dependabot PRs go through CI. Next.js patches promptly (security) |
| Browsers | Next.js 15's default targets: current Chrome, Edge, Firefox, Safari | Run TEST-PLAN on Chrome and Safari (iPhone) before each release |
| Devices | Public site: mobile first. Console: desktop first, usable on a phone for leads, inbox and calls | To verify: no device test is written down yet |
| Accessibility | WCAG 2.1 AA as the target: keyboard, labels, contrast | Never cut (ponytail rule); add an axe check to the TEST-PLAN |
| Mail | Gmail (send, ADR 0026), Outlook / Microsoft 365 (ADR 0076, needs Entra publisher verification) | A second mailbox provider goes behind the same adapter |
| Calendars and meetings | Google, Outlook, Zoom (ADR 0019, 0032, 0076) | Appointments are ours; calendars mirror them |
| Phone | Twilio, the agency's own account or a platform-managed subaccount (ADR 0090); Retell for AI calls | Vendor SDK only behind an adapter |
| Imports | CSV, Google Sheets (listings and contacts). REAXML skipped for launch (the user, 2026-11-06) | REAXML when a CRM migration asks for it |
| Time | Every agency has its own time zone (ADR 0027); sending hours follow it | Never `new Date()` in a prompt |
| Money and numbers | `price_display` and `price_from` / `price_to` both stored; the AI never computes a number | CLAUDE.md #4, #6 |
| Public API | Version 2 (the user, 2026-11-06), as `/v1` with keys, scopes, idempotency and SSRF guards (hardening Phase 8) | ADR first |
| Moving vendors | Platform-neutral code: Vercel → Workers, Supabase → Aurora, Supabase Storage → R2 each stay a contained move | No `@vercel/*` or Cloudflare-only package outside an adapter |

---

## 10. The flows

### A console request
```
Today:  browser → middleware (getClaims; any error = sign-out) → unsigned x-console-user-*
        → Server Component → can() → DB (max 10, no timeout)
Target: browser → middleware (getClaims; network error = 503, no session = /login)
        → x-console-user-* + HMAC → page verifies → can() → DB (max 2, statement_timeout 10 s)
```

### A public visitor
```
browser → Vercel CDN (ISR page) → on a miss: Server Component → core/search (public read model)
photos → next/image (V1) → R2 + CDN (V2)
public AI → rate limit (IP, user) → checkAiBudget (platform pays, its own cap) → packages/ai → ai_run
```

### An AI call by an agent (with credits)
```
assistant / skill → can(actor, skill) [plan includes it, switch on]
  → checkAiBudget: platform cap · agent daily cap · agency daily cap · agency credit balance
  → refused? "Out of AI credits — buy more" (owner) / "ask your owner" (agent)
  → packages/ai → Anthropic (cached prompt) → usage.ts writes ai_run (cost_usd)
  → the balance drops by cost_usd × 100 credits
```

### A webhook (Twilio, Retell, Zoom, Resend, Stripe)
```
Today:  provider → route → all the work inside the request → 200
Target: provider → verify signature/token → store the event id once (replay = no-op)
        → write a job row → 200 within ~1 s
        → minute tick claims the job (SKIP LOCKED) → work → retry with backoff → dead-letter
```

### Onboarding a new agency
```
sign-up / invite → agency row (plan = trial) → owner sets MFA → Stripe Checkout (plan)
  → invoice.paid → credits granted → skills allowed by the plan, switched on by the owner
  → import: file to Storage (signed URL) → job → 1,000-row chunks, fair share, ETA shown
  → no automation fires from an import → ANALYZE → done (undo for 14 days)
```

### Billing (Stripe)
```
owner → Checkout (plan, extra seats, or a top-up) → Stripe
Stripe → webhook: invoice.paid → monthly credit grant
                  checkout.session.completed → top-up grant (12 months)
                  customer.subscription.updated/deleted → agency.plan
80% used → email the owner · 100% → AI stops, the rest keeps working
```

### Shipping a change
```
branch (worktree) → pnpm test + break-test → pnpm smoke on the DEV database
  → PR → CI (frozen install, typecheck, lint, test, audit, gitleaks) → the other developer reviews
  → merge → Vercel deploy → production migration: one runs it, the other approves
    (CONFIRM_PRODUCTION=<host>, tried first in a rolled-back transaction)
  → STATUS.md and this plan ticked
```

### An incident
```
alert (Sentry / uptime / dead-man / spend) → the runbook for it (4.1) → contain → fix or roll back
  → personal data involved? → breach runbook: assess within 30 days, the boss notifies the OAIC
  → write-up in SESSION.md, and a test that would have caught it
```

---

## 11. Limits

### Rate limits (Upstash; the same in every version)

| Route / action | Key | Limit |
|---|---|---|
| Login, sign-up, password reset | IP / email | 10 a minute per IP; 5 per 15 min per email |
| Invite claim | IP | 10 a minute |
| `/api/places` (Google) | IP | 30 a minute |
| `/api/chat` and the other public AI routes | IP / user | 10 a minute and 60 a day per IP; 100 a day per user |
| `/api/activity` | IP | 60 a minute (the browser batches) |
| `/api/reviews` | IP | 5 an hour |
| Console requests | user | 600 a minute |
| Console assistant | user | 10 turns a minute |
| Webhooks | none per IP | signature, event id stored once, 200 within ~1 s |

### Caps that grow with the version

| Cap | V1 | V2 | V3 |
|---|---|---|---|
| `AI_DAILY_BUDGET_USD`, platform (today **$20**, used up within hours at V1) | $300 | $600 | $1,200 |
| AI per agent per day (runaway brake) | $1.50 | $1.50 | $1.50 |
| AI per agency per day | seats × $1.50 | same | same |
| AI per public user per day (today $0.25) | $0.25 | $0.25 | $0.25 |
| AI credits a month | by plan (section 13) | same | same |
| Emails per agent per day (today 50) | 150 *(to decide)* | 150 | 150 |
| Emails per agency per day (today 200) | 1,000 *(to decide)* | 1,000 | 1,000 |
| SMS per number per day | 100 | 100 | 100 |
| SMS throughput, platform-wide, fair per agency | 300 a minute | 600 a minute | 1,200 a minute |
| Import rows a second, platform-wide | 500 | 1,000 | 2,000 |
| Google Maps daily quota per API | 3,000 | 7,000 | 15,000 |
| Postgres connections per instance | 2 | 2 | 2 |
| `statement_timeout`: console / public / workers | 10 s / 5 s / 60 s | same | same |
| Pooler clients (from the compute size) | 800 | 1,000 | 1,500 |

---

## 12. Cost

Monthly, typical use, USD. Twilio and Retell are charged on to agencies and are not counted here.

| Line | V1 | V2 | V3 | Basis |
|---|---|---|---|---|
| Supabase | 290 | 550 | 1,270 | Pro $25 + Large $110 / XL $210 / 2XL $410 + replica ~$410 **(est.)** − $10 credit + PITR $100 per 7 days + disk, storage, egress + dev $10 |
| Vercel | 400 | 450 (after R2) | 860 (incl. R2) | 2 seats × $20 + functions + bandwidth/images **(est.)** |
| **AI (Anthropic)** | **4,600** | **9,200** | **18,400** | $9 per agent + $0.04 per public user **(est.)** |
| Email (Resend) | 200 | 350 | 650 | volume tiers |
| Google Maps | 150 | 350 | 700 | 10k free per SKU, then $2.83–5 per 1,000 **(est. volume)** |
| Sentry, Upstash, S3, uptime, password manager | 100 | 200 | 350 | |
| **Total a month** | **≈ $5,750** | **≈ $11,100** | **≈ $22,250** | |
| **Total a day** | **≈ $190** | **≈ $370** | **≈ $740** | weekdays ~35% higher |
| Without AI | ≈ $1,150 | ≈ $1,900 | ≈ $3,850 | |
| In A$ a month | ≈ A$8,900 | ≈ A$17,200 | ≈ A$34,500 | |

**AI is ~80% of the bill.** The working: the assistant runs on Sonnet 5.5, a question is 2–3 cached
calls at about $0.035, ten questions a working day comes to $7.70, and drafts and documents add $1.30.
That makes **$9 per agent a month**: light agents about $4, heavy ones up to the cap. Replace this with
the AI cost page's real number after the first month.

### Per agency, agent, user
- **By cause:** an agent ≈ $9.40 a month (AI + email). An agency ≈ $3–5 (database, storage, backups,
  maps, bandwidth). A public user ≈ $0.04–0.05.
- **All-in average:** ≈ $11 per agent a month (≈ $0.37 a day), ≈ $22–29 per agency a month.
- **SMS** for an agent who texts: ~$17 a month (200 × $0.0515 + a number), passed on.
- **Voice AI:** $0.07–0.31 a minute, passed on.
- **V4 (est.):** ≈ $47,000 a month, plus a second cell and one operations hire.

### Cheaper AI (each change needs an eval first)
- Haiku 5.5 ($0.10/$0.50) instead of Haiku 4.5 ($1/$5) for the property chat and alert summaries.
  Add its price to `models.ts` first.
- The Batch API (half price) for work nobody waits on.
- Opus routes (imports, documents) tried on Sonnet 5.5 at lower effort.
- Together these take AI from $9 to about $5–6 per agent.

**Not counted anywhere above:** salaries, support, legal, a penetration test, accounting.

---

## 13. Pricing: three plans with AI credits

**Credits, not tokens.** A token's price differs by model (an Opus 5.5 output token costs 40× a Haiku 5.5
one), and we sell our product, not Anthropic API access. **1 credit = US$0.01 of model cost**, read from
`ai_run.cost_usd`, which every call already writes.

| Action (est.) | Credits |
|---|---|
| One question to the assistant | 3–4 |
| An email draft, a property summary | 1–3 |
| A listing copy draft | ~5 |
| Reading a document | 10–30 |
| AI help on an import | 20–100, once |
| A typical agent in a month | **~900** |

### The plans (A$ a month, ex GST)

| | **Starter** | **Growth** | **Pro** |
|---|---|---|---|
| Price | **A$149** | **A$349** | **A$699** |
| Seats included | 1 | 3 | 6 |
| Extra seat (adds 800 credits) | A$79 | A$69 | A$59 |
| **AI credits a month** | **1,000** | **3,000** | **7,000** |
| Core | CRM, contacts, listings, public site, enquiries, inbox, imports, email | same | same |
| Skills (`skill-switches/catalog.ts`) | `bulk_email`, `ai_email_drafts`, `workflow_emails`, `ai_listing_copy`, `property_summaries`, `buyer_matching`, `ai_import`, the five opportunity alerts | + `ai_understand_enquiries`, `ai_workflow_decisions`, `dashboards`, `knowledge_answers`, `team_meetings`, `bulk_sms`, `workflow_texts`, `missed_call_text` | + `agency_performance`, `team_activity`, `team_management`, `ai_callback` |
| Support | Email | Email | Priority |

Twilio is free with the agency's own account, or at **cost + 25%** prepaid on a managed subaccount.
Voice AI is billed per minute (e.g. A$0.60). Public users are free.

### Top-ups

| Pack | Price | Our cost | Margin |
|---|---|---|---|
| 1,000 credits | A$29 | A$15.50 + Stripe | ~44% |
| 5,000 credits | A$129 | A$77.50 + Stripe | ~38% |

Rules:
- The monthly allowance resets on the billing date and does not roll over. Top-ups last 12 months.
  The allowance is spent first.
- The owner is emailed at 80% and 100%.
- At 0, **only the AI stops**. Everything else keeps working.
- The daily caps stay as a brake on a runaway loop.
- The public site's AI never spends an agency's credits.
- The check is advisory (two requests can read the same balance), so a balance may dip a few credits
  below 0 before the next call is refused. The Anthropic console limit is the last stop.

### Profit (est.)

| | Starter | Growth | Pro |
|---|---|---|---|
| Our cost if every credit is used | A$26 | A$62 | A$132 |
| **Margin at full use** | **82%** | **82%** | **81%** |

| | V1 (70 Starter, 100 Growth, 30 Pro) | V2 (same mix ×2.5, if it holds) | V3 (×5) |
|---|---|---|---|
| Plan revenue a month | A$66,300 | A$165,750 | A$331,500 |
| Running cost + Stripe | ≈ A$10,100 | ≈ A$20,500 | ≈ A$41,000 |
| **Gross profit a month** | **≈ A$56,200 (85%)** | **≈ A$145,250 (88%)** | **≈ A$290,500 (88%)** |
| Gross profit a day | ≈ A$1,870 | ≈ A$4,840 | ≈ A$9,680 |

Top-ups come on top of this. **Floor:** never a credit below A$0.016, never a seat below A$45. If the
real AI use is above 900 credits per agent, raise the price or lower the allowance.

Market check: Australian real-estate CRMs charge about A$50–200 per user a month (Rex's own article).
AiVARE lists from A$179 per user.

### How it is built (with Stripe; ADR first)
Already there:
- `agency.plan` (`schema.ts:138`, default `'trial'`), which the admin can change (ADR 0050). Nothing
  reads it yet.
- Skill switches per agency.
- `ai_run.cost_usd`.
- `checkAiBudget`, which already has an agency window.

New:
1. **A plan map in `packages/core`, held in code:** plan → skills, credits, seats. `can()` refuses a
   skill outside the plan, with a permission test for each plan.
2. **`ai_credit_grant`:** agency, credits, source (`plan` | `topup` | `admin`), valid from, expires,
   Stripe reference (unique). The balance check is a fourth window in `checkAiBudget`.
3. **Stripe:** three plan prices, an extra-seat price, two top-up prices; Checkout and the Customer
   Portal; webhooks with a signature check and each event stored once.
4. **Owner-only purchase:** `can(actor, 'billing:manage', agency)`, with a permission test. Grants show
   on the admin's AI cost page.

---

## 14. Order of work

**Progress, 2026-11-17** (about 12% of V1; estimates per step, not measured):

| Step | Done | Left |
|---|---|---|
| 0 Clean the base | 80% → this PR | — |
| 1 Dev database | 90% | the other laptop's `.env.local`; an agency on dev, then `db:seed` |
| 2 Production guard | 90% | merge `chore/dev-db-and-prod-guard` |
| 3 Backups | 20% | one manual encrypted dump done; PITR deferred; 0.4 (scheduled off-site dump + alert) and the restore drill |
| 4 Accounts and alarms | 5% | spend stops, Sentry, Upstash, 2FA, branch protection, gitleaks, Dependabot |
| 5–27 | 0–20% | 1.6 (Retell signature) and 0097's indexes are done; the rest not started |

Legend for the tables below: **Size** S = one session, M = two or three, L = about a week (est.).
**Who** CC = Claude Code (`packages/db`, `core`, `auth`, `ai`) · CU = Cursor (`apps/`, `ui`) · Boss = accounts,
money, legal. **Done when** is the proof; a task without its proof is not done.

### 14.0 The steps, in order

This is the order of work. The task numbers (0.1, 1.4 …) point to the tables below, which hold each
task's proof. **Steps 1–4 come before any new skill or module.**

#### How every step runs
1. **Worktree + branch** for the step (`ops/step-N-<name>`), because parallel sessions share the main
   folder.
2. **Tests first, then the change**, then a **break-test**: undo the fix and see the new check go red.
3. `pnpm test` (offline, free). `pnpm smoke` runs only on the **dev** database.
4. **PR → CI → the other developer reviews → merge.** One PR per step, small enough to read in one
   sitting.
5. **Anything that touches production** (a migration, an env value, a vendor setting) waits for an
   explicit "go" in chat. One developer runs it and the other watches. Migrations go to dev first, and
   to production at night.
6. Tick the task here and in STATUS.md, and add an entry to SESSION.md.

#### Decisions before step 0 (made 2026-11-16 and 2026-11-17)
- **a.** The stacked branch (pre-launch criticals, hybrid Twilio, control centre part A, Retell signature) is merged into `main` and live.
- **b.** `feat/crm-visibility` and `feat/crm-assistant-more` are **not merged**: tagged `archive/crm-visibility` and `archive/crm-assistant-more` on GitHub, branches kept locally.
- **c.** The old database stays production; `realestate-dev` (Sydney) is dev. Done (0.1).
- **d.** `SCALING-PLAN.md` deleted; this file is the only plan. The former production plan became this section.
- **e.** Prices: later, at step 15. PITR: **off for now** (cost, early testing), see section 15. Retention: section 8.

#### Week 1: safety (nothing new is built until step 4 is done)
| Step | What | How | Tasks |
|---|---|---|---|
| **0** | **Clean the base** | Decisions a, b, d. Commit the two plan files. Remove the merged worktrees. Every later branch starts from `main` | — |
| **1** | **Dev database** | The boss creates `realestate-dev` (Supabase, Sydney, Micro). We run migrate and seed against it. `.env.local` on both laptops points at dev. Production values move into Vercel (Production scope) and the password manager; Vercel Preview gets the dev values | 0.1 |
| **2** | **Production guard** | One helper in `packages/db` that refuses a host listed in `PRODUCTION_DB_HOSTS` unless `CONFIRM_PRODUCTION=<host>` is set. Called by `reset.ts`, `seed.ts`, `clear-listings.ts`, the repair, census and zones scripts, smoke, and `drizzle.config.ts` (for `db:migrate`). Break-test: `db:reset` against production with no flag must exit | 0.2 |
| **3** | **Backups** | The boss turns PITR on (7 days). We restore it once into a scratch project and compare row counts. Then a GitHub Actions schedule runs an encrypted `pg_dump` every 6 h to S3 Melbourne (Object Lock, separate AWS account), and healthchecks.io alerts when a dump is missed | 0.3, 0.4 |
| **4** | **Accounts and alarms** | The boss: spend limits at every vendor, Sentry DSN, an Upstash account, accounts in the business's name with 2FA. CU: branch protection, gitleaks, Dependabot | 0.5, 0.6, 0.7 |

**Gate:** from here, new skills and modules may be built **on the dev database**, each following the
checklist in 14.8.

#### Weeks 2–3: hardening
| Step | What | How | Tasks |
|---|---|---|---|
| **5** | Auth that fails safe | 503 instead of a sign-out when auth is unreachable; HMAC-signed session header. One PR, smoke on dev | 1.1, 1.2 |
| **6** | Database connections | `max: 2`, connect and idle timeouts in `client.ts`; `statement_timeout` per role. Dev first, then production at night | 1.8, 1.9 |
| **7** | Indexes | One migration with ~20 indexes (the `agency_id` columns and big-table FKs in 1.10); `pg_stat_statements` on; the migration rules and the `CONCURRENTLY` script in DEPLOY.md | 1.10, 1.11, 1.13 |
| **8** | Rate limits | The Upstash limiter replaces `apps/web/lib/rate-limit.ts`; console routes added; Vercel Firewall rules; Turnstile | 1.4, 1.5 |
| **9** | Small fixes | PII out of the logs; timeouts on every vendor `fetch`; V1 caps in env (AI $300 a day); model prices. One PR | 1.7, 1.15, 1.17, 1.18 |
| **10** | MFA | TOTP for owners, admins and platform admins; 15-minute JWT; sign out everywhere | 1.3 |
| **11** | Health and errors | `/api/health` + an uptime monitor; `error.tsx` in each route group; one error shape for API routes | 1.14, 1.16 |
| **12** | Data layout | UUIDv7, lz4, `pg_trgm`, on dev first | 1.12 |

Retell's signature check (1.6) is already done on `fix/retell-signature-and-0090-tests` and lands in
step 0.

#### Weeks 3–4: money
| Step | What | How | Tasks |
|---|---|---|---|
| **13** | ADR for plans and credits | Written by CC, reviewed by the user and the boss before any code | 2.1 |
| **14** | Plan map and credit ledger | Plan → skills, credits, seats in `packages/core`; the `ai_credit_grant` table; the fourth window in `checkAiBudget`; a permission test for each plan | 2.2, 2.3 |
| **15** | Stripe | Test mode first: prices, Checkout, Customer Portal, webhooks (signature + event id stored once), owner-only purchase, 80% and 100% emails, the admin cost page | 2.4–2.7 |

#### Weeks 4–5: background work
| Step | What | How | Tasks |
|---|---|---|---|
| **16** | `job` table | Retries, backoff, dead-letter, fair share per agency, on the minute tick | 3.1 |
| **17** | Webhooks through jobs | Twilio, Retell, Zoom, Resend and Stripe answer 200 in about 1 s | 3.2 |
| **18** | SMS and imports | A fair SMS drain; imports start no automations; incremental scans | 3.3, 3.4 |
| **19** | When a vendor is down | AI → template; Twilio → email; email → retry, each with a fake-client test | 3.5 |

#### Week 5: proof
| Step | What | How | Tasks |
|---|---|---|---|
| **20** | E2E | Playwright, five flows, on previews against the dev DB; smoke nightly in CI | 4.1, 4.2 |
| **21** | Load test | k6, V1 and V2 profiles, 60 minutes, on a dev DB seeded to production size | 4.3 |
| **22** | Quality checks | jsx-a11y + axe; iPhone, Android and slow 3G; route audit + ZAP | 4.5, 4.6, 4.7 |
| **23** | Restore drill | Automatic and monthly from now on | 4.4 |

#### Week 6: launch
| Step | What | How | Tasks |
|---|---|---|---|
| **24** | Legal and runbooks | Privacy policy, terms, DPA; the breach runbook and the seven runbooks; secrets inventory | 5.1–5.4 |
| **25** | Domains and senders | Cloudflare DNS only; domains on Vercel; SPF, DKIM, DMARC; ACMA sender ID; EXIF removed from photos | 5.5–5.8 |
| **26** | Clean up | Test data out of production; support inbox; status page | 5.9, 5.10 |
| **27** | **Go / no-go** | The user, the boss and both developers walk the list in 14.7. All ticked → the first agency | — |

#### After launch
Routines and triggers in 14.9; each version's work in 14.10. Re-plan at the end of week 2,
using the real speed.

---

### 14.1 The hosting path

One table for the whole journey. We move a piece **only when its trigger fires**, never because a
version number arrived.

| Piece | V1 (launch) | V2 | V3 | V4+ |
|---|---|---|---|---|
| Web apps (UI + API) | Vercel Pro, `syd1`, Fluid compute | same | same | same, unless the Vercel bill for functions passes the cost of one ops engineer |
| Database | Supabase Pro, **Medium** at launch → **Large** before ~100 agencies | XL | 2XL + read replica | Cells (~1,500 agencies); Aurora/RDS only if Supabase HA or price fails |
| Files (photos, documents) | Supabase Storage, photos as variants | **Cloudflare R2** (trigger: bandwidth) | R2 | R2 |
| Background work | Our Postgres `job` table on the minute tick | same | Same code in a **worker container** (AWS Fargate) if jobs crowd the web functions | Workers on AWS |
| Rate limits | Upstash Redis (Sydney) + Vercel Firewall for IP rules | same | same | same |
| DNS / edge | Cloudflare **DNS only** (grey cloud) + Turnstile | same | same | same |
| Backups | PITR 7 days + `pg_dump` to S3 Melbourne | PITR 14 days | same | per cell |
| Monitoring | Sentry + `/api/health` + uptime monitor + healthchecks.io | same | + on-call rota | + log store |

**Not doing:** Cloudflare as a proxy in front of Vercel (Vercel advises against it: it breaks Vercel's
firewall and bot protection); a separate API server the UI calls; Kafka; Kubernetes; microservices.

#### Ideas we checked and why we changed them
These came from an outside plan. Each was checked against our code and current vendor pricing.

| Idea | What we found | Our decision |
|---|---|---|
| R2 from V1 | V1 photos cost ~$11/month in Supabase Storage. R2 adds an account, keys and code for no saving yet | R2 at V2, when bandwidth passes its trigger. Keep storage behind one module so the move is small |
| V2: AI waits make Vercel "GB-hours shoot up", so move AI to QStash/Inngest | With Fluid compute, waiting on Anthropic bills **memory only** (~$0.0106 per GB-hour), not CPU, and one instance serves many requests. 10,000 AI questions a day × 20 s ≈ $20/month. AI tokens cost ~$9,000/month at V2 | AI stays in the request (streaming). Long work (imports, documents, bulk sends) goes to our `job` table in **V1**, because of retries and fairness, not cost |
| V3: Vercel will force Enterprise | Pro is pay-as-you-go with no hard ceiling at our traffic. Enterprise sells SLA, SSO and support | Re-check at V3 with real bills. Not a trigger by itself |
| V3: UI calls an AWS backend directly | That is a second API with its own auth, and it breaks two rules (logic in `packages/core`; the server is the only door) | Run the **same `packages/core` code** in a worker container that drains the `job` table. The UI keeps calling its own Next.js server |
| Triggers: Vercel bill $200–300, a vendor's "move to Enterprise" email | We already expect ~$400/month on Vercel at V1 (images and bandwidth). A sales email is not a measurement | Use the measured triggers in 14.9 |
| Supabase CPU 70% → read replica | Agrees with our trigger (p95 CPU above 60% for 7 days) | Kept, as in 14.9 |

---

### 14.2 Phase 0: safety — before any new module (week 1)

New skills and modules are built against a database. Today that database **is production**, so this phase
comes first.

| # | Task | Who | Size | Done when |
|---|---|---|---|---|
| 0.1 | **Dev database:** a new Supabase project in Sydney (Micro), migrated and seeded. `.env.local` points at it. Production keys live only in Vercel and the password manager | CC + Boss | S | `pnpm smoke` runs against dev; nobody's laptop holds a production URL |
| 0.2 | **Production guard:** every DB script (`db:migrate`, `db:reset`, seeds, smoke) refuses a production host unless `CONFIRM_PRODUCTION=<host>` is set | CC | S | Running `db:reset` with the production URL and no flag exits with an error (break-test) |
| 0.3 | **Deferred 2026-11-17 (cost):** **Point-in-time recovery on** (7 days), then one restore into a scratch project | Boss + CC | S | Row counts of five tables match after the restore; `DEPLOY.md:67` ticked |
| 0.4 | **Off-site backup:** encrypted `pg_dump` every 6 h to S3 Melbourne (Object Lock, separate AWS account); healthchecks.io pings on success | CC | M | A missed dump sends an alert; one dump restored on dev |
| 0.5 | **CI:** branch protection on `main`, gitleaks, Dependabot (frozen install and `pnpm audit` are already in `ci.yml`) | CU | S | A PR with a fake key in it fails |
| 0.6 | **Hard spend stops:** Vercel Spend Management, Supabase spend cap, Anthropic console limit, Google quotas, Twilio triggers, Retell minutes | Boss | S | Every vendor shows a limit in its console, written in the secrets inventory |
| 0.7 | **Sentry DSN** set in both apps, alerts for new errors and 5xx rate | CU | S | A thrown test error reaches Sentry with no email, cookie or query string |

---

### 14.3 Phase 1: hardening (weeks 2–3)

New modules may run in parallel from here, if each one follows 14.8.

#### Security and auth
| # | Task | Who | Size | Done when |
|---|---|---|---|---|
| 1.1 | Auth outage → 503 + `Retry-After`, not a sign-out (`packages/auth/src/middleware.ts:131`) | CC | S | `getClaims` throwing a network error returns 503 in a test |
| 1.2 | **Signed session header** (HMAC + expiry) between middleware and pages | CC | S | A forged `x-console-user-*` header without the signature is refused (smoke) |
| 1.3 | **MFA** (TOTP) for owners, admins and platform admins; 15-minute JWT; "sign out of all devices" | CC + CU | M | An owner without MFA cannot open billing or team pages |
| 1.4 | **Rate limits on Upstash**, replacing the in-memory limiter in `apps/web/lib/rate-limit.ts` (each Vercel instance counts on its own today, so the limit is not real). Add the console routes. Limits as in section 11 | CC + CU | M | Two parallel instances share one count (test with two clients); `429` with `Retry-After` |
| 1.5 | Vercel Firewall rules for IP floods; Turnstile on sign-up, login and reset | CU | S | A scripted login loop is blocked |
| 1.6 | Retell signature check **on by default** (`voice.ts:87`) | CC | S | An unsigned Retell call is refused |
| 1.7 | **No personal data in logs:** `apps/web/lib/offer-action.ts:133` logs an email; `apps/console/app/(agency)/team/actions.ts:40` logs a whole error object. Fix both and add a lint rule or grep check | CU | S | The grep check runs in CI |

#### Database
| # | Task | Who | Size | Done when |
|---|---|---|---|---|
| 1.8 | **Connections:** `max: 2` per instance (today 10, `packages/db/src/client.ts:6`), connect and idle timeouts, `statement_timeout` per role (console 10 s, public 5 s, workers 60 s) | CC | S | 200 parallel requests in the load test stay under the pooler limit |
| 1.9 | **Compute:** Medium at launch; set an alert at 60% CPU | Boss | S | Alert fires on a test |
| 1.10 | **Indexes, first pass:** 146 of 260 foreign keys have no index that starts with them (script count, est.). Add only those on tables that grow (`agency_id` on `membership`, `team`, `office`, `notification`, `workflow_run`, `activity`, `note`, `team_message`, `ai_query_ticket`; FKs that `ON DELETE` walks on big tables). Skip audit columns such as `created_by` | CC | S | `EXPLAIN` on the agency's member list, notifications and workflow runs uses an index; tried on dev first |
| 1.11 | **`pg_stat_statements` + Supabase index advisor** on; a weekly look at the top 10 slow queries | CC | S | The first weekly report is written in SESSION.md |
| 1.12 | Data layout while tables are small: UUIDv7 for new big tables, lz4 on text-heavy columns, `pg_trgm` for name search (D1, P1–P3) | CC | M | Tried on dev, then production at night |
| 1.13 | **Migration rules** in `DEPLOY.md`: expand → backfill → contract; a lock of at most 1 s; indexes on big tables with `CREATE INDEX CONCURRENTLY` in a separate script (Drizzle runs migrations in a transaction, where `CONCURRENTLY` cannot run) | CC | S | The rule is written and the script exists |

#### Reliability
| # | Task | Who | Size | Done when |
|---|---|---|---|---|
| 1.14 | `/api/health` in both apps (DB ping, last cron run, last backup age) + an uptime monitor | CU | S | Stopping the cron makes health say "late" |
| 1.15 | **Timeouts on outbound calls:** 63 `fetch` calls, 16 files with `AbortSignal.timeout`. Every call to a vendor gets a timeout | CC | S | A grep check in CI: no `fetch(` to a vendor without a signal |
| 1.16 | `error.tsx` in each route group (5 today); one error shape for API routes (`{ error: { code, message } }`) | CU | S | Throwing in a page shows the group's error screen, not a blank page |
| 1.17 | **V1 caps in env** (section 11): AI platform $300 a day (today $20, which runs out within hours at V1) | CC | S | `checkAiBudget` reads the new values |
| 1.18 | Fix model prices in `packages/ai/src/models.ts`: Sonnet 5.5 cache read, add Haiku 5.5 | CC | S | A unit test checks the price table |

---

### 14.4 Phase 2: money — Stripe, plans, credits (weeks 3–4)

Full design: section 13. ADR first.

| # | Task | Who | Size | Done when |
|---|---|---|---|---|
| 2.1 | ADR: plans, credits, top-ups, trial rules | CC | S | ADR merged |
| 2.2 | Plan map in `packages/core` (plan → skills, credits, seats); `can()` refuses a skill outside the plan | CC | S | A permission test for each plan |
| 2.3 | `ai_credit_grant` table; balance as the fourth window in `checkAiBudget` | CC | M | A test: allowance spent first, then the top-up; at 0 only AI stops |
| 2.4 | Stripe: three plan prices, extra seat, two top-ups; Checkout + Customer Portal | CU | M | A test-mode purchase grants credits once |
| 2.5 | Stripe webhooks: signature check, event id stored once (`invoice.paid`, `checkout.session.completed`, `customer.subscription.updated/deleted`) | CC | S | Replaying the same event grants nothing twice |
| 2.6 | `billing:manage` for owners only; emails at 80% and 100% | CC + CU | S | Permission test: an agent cannot buy |
| 2.7 | Admin AI cost page shows grants and spend per agency | CU | S | One agency's month adds up to its `ai_run` rows |

---

### 14.5 Phase 3: background work (weeks 4–5)

| # | Task | Who | Size | Done when |
|---|---|---|---|---|
| 3.1 | One **`job` table**: retries with backoff, dead-letter state, fair share per agency, claimed with `SKIP LOCKED` on the minute tick | CC | M | A job that fails 5 times lands in dead-letter and shows on the admin page |
| 3.2 | Webhooks (Twilio, Retell, Zoom, Resend, Stripe) answer 200 within ~1 s and do their work as jobs | CC | M | A slow handler no longer delays the 200 |
| 3.3 | SMS drain with per-agency fairness (today ~100 a minute platform-wide) | CC | S | 200 agencies' 9 am batches finish within sending hours in a test |
| 3.4 | Imports start no automations; scans are incremental | CC | S | A 10,000-row import fires zero workflow events |
| 3.5 | When a vendor is down: AI → template + "AI was unavailable"; Twilio → email the agent; email → retry | CC | S | Each path has a fake-client test |

---

### 14.6 Phase 4: proof — tests, load, devices (week 5)

| # | Task | Who | Size | Done when |
|---|---|---|---|---|
| 4.1 | **E2E (Playwright)** for five flows: sign in, publish a listing, a buyer's enquiry reaching the agent, an import, an AI assistant answer (fake model). Runs on previews pointed at the dev DB | CU | M | CI fails when one of them breaks |
| 4.2 | `pnpm smoke` nightly against the dev DB in CI | CC | S | A red smoke run alerts |
| 4.3 | **k6 load test** with V1 and V2 profiles, 60 minutes, on a seeded dev DB at production size | CC | M | p95 targets of section 5 hold at V2 numbers |
| 4.4 | Restore drill (monthly from now on, automatic) | CC | S | The last drill's date shows on `/api/health` |
| 4.5 | Accessibility: `eslint-plugin-jsx-a11y` + an axe check on the five E2E pages | CU | S | Zero serious issues |
| 4.6 | Devices: TEST-PLAN on iPhone Safari, Android Chrome and a slow-3G profile | CU | S | Results written in TEST-PLAN.md |
| 4.7 | Route audit (every handler listed as authed or public) + OWASP ZAP scan | CC | S | No unlisted route; ZAP has no high finding |

---

### 14.7 Phase 5: launch (week 6)

| # | Task | Who | Done when |
|---|---|---|---|
| 5.1 | Privacy policy: every overseas sub-processor, retention, ADR 0083 (viewers named to agencies) | Boss + CU | Published; a lawyer has read it |
| 5.2 | Terms of service + a data processing agreement agencies sign | Boss | Signed by the first agency |
| 5.3 | Breach runbook (NDB, OAIC) + runbooks: app crash → rollback, DB down → restore, key leaked, bot flood, AI bill spike, vendor down, lost account access | CC + Boss | Each one tried once as a drill |
| 5.4 | Secrets inventory with expiry dates (the Microsoft Entra secret expires) | Boss | One list, in the password manager |
| 5.5 | DNS on Cloudflare (DNS only); domains on Vercel; `COOKIE_DOMAIN` set | CU | All three hosts serve over HTTPS |
| 5.6 | Email: SPF, DKIM, DMARC; real sender name and postal address; sign-up email confirmation on | CU + Boss | mail-tester score 9+ |
| 5.7 | SMS sender ID on the ACMA register (before SMS sells) | Boss | Registered |
| 5.8 | Photos resized in the browser, EXIF/GPS removed | CU | An uploaded phone photo has no GPS tag |
| 5.9 | All vendor accounts in the business's name, with 2FA; a shared password manager; registrar lock | Boss | Checklist ticked |
| 5.10 | Test data cleared from production; support inbox; a simple status page | CU + Boss | Done |

#### Go / no-go for the first agency
All must be true:
- [ ] 0.1–0.7 done (dev DB, guard, PITR, off-site backup, CI, spend stops, Sentry)
- [ ] 1.1–1.4, 1.6, 1.8, 1.14, 1.17 done
- [ ] Stripe test-mode purchase works end to end (2.4, 2.5)
- [ ] Five E2E flows green; the V1 load test passes
- [ ] One restore drill passed
- [ ] Privacy policy and terms published

---

### 14.8 Every new skill or module: the checklist

Tomorrow's modules follow this, so growth does not undo the hardening.

- [ ] ADR (10 lines) if it is a new area or a new vendor.
- [ ] Types and zod schemas first.
- [ ] Every new table has `agency_id`, scoped reads, and an index for each query it serves; big tables
      get time-ordered ids.
- [ ] `can(actor, action, resource)` on every action and route, with a **permission test**.
- [ ] Business logic in `packages/core`; nothing in `apps/`.
- [ ] Any model call goes through `packages/ai` → `usage.ts` → `ai_run`; a fake client in tests; the
      skill has a catalog key, a plan in the plan map, and a credit cost row.
- [ ] Anything slow or external is a job; network calls never inside a transaction; every `fetch` has a
      timeout.
- [ ] Lists have `.limit` and a cursor; no query per row (`query-count.test.ts`).
- [ ] Rate limit for any new public or AI route.
- [ ] `loading.tsx` and an error state; keyboard and labels.
- [ ] No personal data in logs.
- [ ] Unit test + a break-test; a smoke invariant if it guards data; the E2E list updated if it is a
      core flow.
- [ ] Migration follows expand → contract; tried on dev first.
- [ ] STATUS.md and SESSION.md updated.

---

### 14.9 Running V1: routines, and when to move up

#### Routines
| When | What | Who |
|---|---|---|
| Daily | Sentry new errors; health and uptime; spend vs caps | The developer on duty |
| Weekly | Top 10 slow queries (`pg_stat_statements`); dead-letter jobs; AI credits used per agent | CC |
| Monthly | Restore drill (automatic); the real bill vs section 12; Dependabot PRs; secrets expiring within 60 days | Both + Boss |
| Quarterly | Load test at the next version; re-price if real AI use per agent is above 900 credits | Both + Boss |

#### Triggers (move when **any one** is true)
| Trigger | Measured where | Action |
|---|---|---|
| 80% of the version's agency count | Admin page | Start the next version's work (14.10) |
| DB CPU p95 > 60% for 7 days, or cache hit < 99% | Supabase reports | One compute size up, at night |
| Pooler clients or disk > 70% | Supabase reports | Compute up; check `max` per instance |
| Console p95 over budget for a week | Load test / Vercel analytics | Fix the slow path first, then scale |
| Vercel bandwidth > $500 a month | Vercel usage | Move photos to R2 |
| Job lag > 2 minutes at peak for a week | `job` table age | Split worker routes; at V3, the worker container |
| Vercel function cost > the cost of running the workers ourselves | Vercel usage vs a Fargate quote | Move workers (only workers) to AWS |

---

### 14.10 After V1: what each version adds

#### Before V2 (500 agencies)
- Photo variants + **R2** (D2).
- Partitions for the two biggest log tables; index shapes; keyset paging on public search; precomputed
  counts (D3, P4, P5, P7).
- Vector search per agency, if embeddings are on (3.15).
- Phone gates 7.4–7.7 if managed Twilio sells (spend cap per subaccount, AU only).
- Confirm Supabase HA and its failover time.
- Compute XL; PITR 14 days.
- **V2 load test passes.**

#### Before V3 (1,000 agencies)
- **Read replica** for reports and AI reads.
- Push instead of poll (Supabase Realtime nudge).
- The isolation test for cells (3.9).
- Imports via Storage with a global budget; `COPY` bulk loads.
- Restore one agency by script; audit log.
- On-call rota.
- If job lag fires: the **worker container** (same `packages/core`, AWS Fargate, Sydney), draining the
  `job` table. The web apps stay on Vercel.
- **V3 load test passes.**

#### V4 and later (2,000+ agencies)
- **Cells** at ~1,500 agencies: agencies split across database stacks, a small directory (agency →
  cell), one global listings index fed by outbox events.
- Aurora/RDS only if Supabase HA or price fails at that size: compare a real quote with Supabase Team or
  Enterprise first.
- Amazon SES if email volume makes Resend the bigger bill.
- One operations hire.
- Each move behind its trigger, one at a time.

---

### 14.11 Timeline (est.)

| Week | Phase | Notes |
|---|---|---|
| 1 | 0: safety | Blocks everything else |
| 2–3 | 1: hardening | New modules may start in parallel, on the dev DB, with the checklist |
| 3–4 | 2: Stripe and credits | |
| 4–5 | 3: background work | |
| 5 | 4: proof | E2E, load test, restore drill |
| 6 | 5: launch | Go / no-go list |

Two developers, est. Real speed decides; re-plan at the end of week 2.

Sources for vendor facts used here: [Vercel and Cloudflare](https://vercel.com/kb/guide/cloudflare-with-vercel),
[Vercel reverse proxy](https://vercel.com/docs/security/reverse-proxy),
[Vercel Fluid compute pricing](https://vercel.com/docs/fluid-compute/pricing),
[Supabase compute](https://supabase.com/docs/guides/platform/compute-add-ons). Other prices: the appendix.

**The boss:** the accounts in the business's name, with 2FA (Supabase Pro, PITR when it is turned on, Vercel Pro, AWS,
Sentry, Upstash, Stripe, Cloudflare); a shared password manager; the registrar lock; a lawyer for calls
and recordings; Microsoft Entra publisher verification; the decisions in section 15.

---

## 15. Decisions

| # | Decision | Who | Outcome |
|---|---|---|---|
| 1 | Today's database stays production and a new one becomes dev | The user | **Decided, done 2026-11-17:** `realestate-dev` (Sydney); `.env.local` points at it |
| 2 | The three plans and their prices (section 13) | The boss | **Later**, at step 15 (Stripe) |
| 3 | Email limits per agent and agency per day | The user | Open. Recommended 150 / 1,000 |
| 4 | Retention periods | The boss | **Decided 2026-11-17:** the agencies' and users' own data is kept while the account is active; time limits apply only to logs, backups and trash; **an agency that leaves is deleted 30 days after it leaves** |
| 5 | MFA for agents too | The user | Open. Recommended: owners and admins at launch, agents 3 months later |
| 6 | Does the other developer review every PR? | Both | Open. Yes, or remove the rule from this plan |
| 7 | PITR from launch day | The boss | **Decided 2026-11-17: off for now** (cost, early testing). Recovery is Supabase's daily backup plus our encrypted `pg_dump` (0.4). Recommended: turn it on before the first paying agency |
| 8 | ADR 0083: keep naming viewers to agencies (and say so), or turn it off | The boss | Open. Recommended: say it in the policy, with an opt-out |
| 9 | The older branches `feat/crm-visibility`, `feat/crm-assistant-more` | The user | **Decided:** not merged; tagged `archive/*` |

---

## 16. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| **Local commands hit production** (no dev DB, no guard) | Data loss | 0.1–0.2, done 2026-11-17 |
| **The AI cap of $20 a day at V1** | Every AI feature stops for everyone within hours | Section 11 caps before launch |
| **AI use above 900 credits per agent** | The margin shrinks | Measure in month one, re-price |
| Auth outage signs everyone out | Every user lands on /login during a blip | 1.1 |
| Unsigned identity header | One middleware bypass = act as anyone | 1.2 |
| No off-platform backup | Losing the Supabase account loses everything | 0.4 (more urgent while PITR is off) |
| SMS 9 am rush | Texts sent late, past 8 pm | 3.3 |
| Managed Twilio bills | The platform pays an agency's texting | Prepaid credit + cap per subaccount |
| Photo bandwidth | Vercel bill at V2 | Variants + R2 |
| Privacy (ADR 0083, sub-processors) | An OAIC complaint | The policy before launch |
| Supabase without HA at V3 | Hours of downtime for 1,000 agencies | Confirm at V2; Aurora plan |

### Docs that are out of date
- `ARCHITECTURE.md` §14 says "no photos anywhere". Uploads exist now (`MAX_MEDIA_BYTES` 10 MB,
  `media/storage-key.ts`).
- `packages/ai/src/models.ts` prices Sonnet 5.5 cache reads at $0.20 (current: $0.10) and has no
  Haiku 5.5 price.

---

## Appendix: unit prices and sources (checked 2026-11-14)

| Vendor | Price | Source |
|---|---|---|
| Supabase | Pro $25 (+$10 credit); Micro $10, Small $15, Medium $60, Large $110, XL $210, 2XL $410, 4XL $960; PITR $100 per 7 days; disk $0.125/GB, storage $0.0213/GB, egress $0.09/GB; Team from $599 | [supabase.com/pricing](https://supabase.com/pricing.md) |
| Vercel | Pro $20 per seat incl. $20 usage; ~1 TB transfer, then ~$0.15/GB | [vercel.com/docs/plans/pro-plan](https://vercel.com/docs/plans/pro-plan), [temps.sh](https://temps.sh/blog/vercel-pricing-complete-guide-2026.md) |
| Anthropic | Sonnet 5.5 $2/$10, Opus 5.5 $4/$20, Haiku 5.5 $0.10/$0.50, Haiku 4.5 $1/$5 per million tokens; Batch API half price | Claude API reference (cached 2026-11-03) |
| Twilio | AU outbound SMS $0.0515 per segment | [twilio.com/sms/pricing/au](https://www.twilio.com/en-us/sms/pricing/au) |
| Retell | $0.07–0.31 a minute | [eesel.ai](https://www.eesel.ai/blog/retell-ai-pricing) (third-party) |
| Resend | Pro $20 for 50k; Scale from $90 for 100k | [activepieces.com](https://www.activepieces.com/blog/resend-pricing-2026-free-tier-plans-and-limits.md) (third-party) |
| Google Maps | 10k free per SKU; autocomplete $2.83, geocoding $5 per 1,000 | [woosmap.com](https://www.woosmap.com/blog/google-places-api-pricing) (third-party) |
| Sentry | Team $26–29 a month, 50k errors | [docs.sentry.io/pricing](https://docs.sentry.io/pricing) |
| Upstash | $0.20 per 100k commands, or $10 fixed | [upstash.com/pricing/redis](https://upstash.com/pricing/redis.md) |
| Market | A$50–200 per user (Rex); AiVARE from A$179 | [rexsoftware.com](https://www.rexsoftware.com/articles/best-real-estate-crm-in-australia-how-to-choose-the-right-one-for-your-agency), [capterra](https://www.capterra.com/p/10039938/AiVARE/) |

Not checked: the Supabase read-replica price, the Twilio AU number price, the Stripe AU fee, the S3
Melbourne price, each vendor's data region, and the exchange rate.
