# V1 implementation status

The execution tracker for **PLATFORM-PLAN.md section 14.12**. The roadmap keeps its assessment of 2026-11-18; this file
records what was actually built, with evidence. A task is **Done** only when it is merged, live where it applies, and its
"Done when" proof holds. **Built** = code and tests on a branch, not merged. Owner actions: `V1-OWNER-ACTIONS.md` (O-n),
owner decisions (D-n).

Updated: 2026-11-18. Baseline (from 14.12): 80 tasks — 1 done, 3 built, 16 partial, 5 unverified, 53 not started, 2 blocked.

## Log
| Date | Task | Branch | Result |
|---|---|---|---|
| 2026-11-18 | 0.2 | `chore/dev-db-and-prod-guard` | Root `pnpm test` now runs @repo/db: CI green with the guard's tests |
| 2026-11-18 | 0.5 | `ops/0.5-ci-security` | gitleaks + Dependabot; history clean after 2 fingerprinted false positives |
| 2026-11-18 | 0.8, 0.12 | `ops/step-3-backups` | Files backup script and workflow; restore-into-new-project procedure; settings and secrets list |
| 2026-11-18 | 1.1 | `fix/1.1-auth-outage-503` | Auth outage → 503, cookie kept; 4 s cap on the Auth wait |
| 2026-11-18 | 1.2 | `fix/1.2-signed-session-header` | Forwarded identity signed and verified |
| 2026-11-18 | 1.24 | `feat/1.24-ai-budget-pools` | Public, trial, paying pools; assistant's unknown-reason pass-through fixed |
| 2026-11-18 | 1.8 (part 1) | `feat/1.8-db-pool` | Pool from env, default 5, with timeouts |

## Tasks
| ID | Task | P | Status | Implementation | Files | Tests | Evidence | External dependency | Remaining risk |
|---|---|---|---|---|---|---|---|---|---|
| 0.1 | Dev database | P0 | Built (branch) | — | — | — | `realestate-dev` live; smoke green on dev 2026-11-17; the other laptop not switched | — | — |
| 0.2 | Production guard | P0 | Built (branch) | Guard on every DB script, smoke and drizzle.config; root `pnpm test` now runs @repo/db's tests | `packages/db/src/production-guard.ts` (+ test), 15 call sites, `package.json` | 4 unit tests; break-test (`db:reset` refused without the flag); CI green on 43f0448 | `chore/dev-db-and-prod-guard` f310c44 + 43f0448; CI run success | Merge (O-1) | Scripts outside the 15 call sites (new ones) must call it: the 14.8 checklist |
| 0.3 | PITR | P1 | Blocked | — | — | — | Decision 7: off for cost | Decision 7 (PITR) | — |
| 0.4 | Off-site DB backup (6 h) | P0 | Built (branch) | — | — | — | `ops/step-3-backups` aec9cd5: tested locally with stand-ins; not merged, no AWS yet | AWS, age key, healthchecks, GitHub secrets (O-6..O-9) | — |
| 0.5 | Branch protection, gitleaks, Dependabot | P1 | Built (branch) | gitleaks 8.30.1 (pinned by checksum) over the whole history in CI; Dependabot weekly (npm grouped, Next.js alone; actions) | `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.gitleaksignore` | Local full-history scan: 2 hits, both Zoom's example token in a test fixture → fingerprinted; break-test: a fake live key in a throwaway repo fails (exit 1) | `ops/0.5-ci-security` f7dc978 | Merge (O-1); branch protection (O-11) | Branch protection is a dashboard setting |
| 0.6 | Vendor spend stops | P0 | Unverified | — | — | — | Dashboards | Vendor dashboards (O-12) | — |
| 0.7 | Sentry DSN + alerts | P0 | Partial | — | — | — | `@sentry/nextjs` wired (ADR 0082); DSN unverified | Sentry DSN (O-13) | — |
| 0.8 | Files backup + recovery key list | P0 | Built (branch) | `scripts/files-backup.sh` (rclone, every bucket listed, sync then size check, empty source refused, healthchecks pings); `files-backup.yml` daily; secrets a restore needs listed in DEPLOY.md | `scripts/files-backup.sh`, `.github/workflows/files-backup.yml`, `docs/DEPLOY.md` | Stand-in rclone/curl: success (2 buckets), empty source (refused + fail ping), failed check (fail ping), missing variable (exit 1) | `ops/step-3-backups` 66d6577 | O-7, O-9, O-10 | **Never run against real Storage or S3** (keys pending; rclone could not be downloaded locally). Object Lock may need Content-MD5 on upload: check on the first run |
| 0.9 | Repo private + history scan | P0 | Not started | — | — | — | GitHub API answers 200 without a token | Repo visibility (O-2) | — |
| 0.10 | Supabase Auth on our SMTP | P0 | Unverified | — | — | — | Dashboard; the built-in sender reaches team only | Supabase SMTP (O-3) | — |
| 0.11 | Preview secrets separate | P1 | Not started | — | — | — | — | Vercel env per environment (O-4) | — |
| 0.12 | Settings document | P0 | Built (branch) | DEPLOY.md: Supabase settings a dump cannot hold (where, ours), app secrets a restore needs, restore into a new project (migrations, then data only with a list file, then files) | `docs/DEPLOY.md` | — (documentation) | `ops/step-3-backups` 66d6577 | Owner fills values that are only in the dashboard | The restore steps are untested until 4.4 |
| 1.1 | Auth outage → 503 | P0 | Built (branch) | `updateSession` returns `unavailable` on a retryable Auth error or no answer in 4 s (auth-js otherwise retries ~30 s); `authUnavailableResponse` (503, Retry-After 15, no-store, JSON for /api and actions); console non-public paths and web account pages use it | `packages/auth/src/middleware.ts` (+ test), `apps/console/middleware.ts`, `apps/web/middleware.ts` | 6 new tests (network failure, 503, valid/none not unavailable, 400 still sign-out, response shapes); break-test: 2 fail with the branch off; typecheck, lint, `pnpm test` 2308+457+29+4 green | `fix/1.1-auth-outage-503` efe356e | Merge (O-1) | `next build` not run locally (Vercel preview builds it) |
| 1.2 | Signed session header | P0 | Built (branch) | HMAC-SHA256 over prefix, id, email, label, exp (2 min); verified with `crypto.subtle.verify` by all three readers; one strip function for every prefix and suffix; no key → refuse (fail closed) | `packages/auth/src/session-header.ts` (+ test), `middleware.ts`, `apps/console/lib/require-console-access.ts`, `apps/console/lib/auth-account.ts`, `apps/web/lib/session.ts`, both middlewares | 7 + 3 new tests; break-test: 3 fail with verification skipped; typecheck, lint, `pnpm test` 2308+457+38+4 green | `fix/1.2-signed-session-header` 800b67a (stacked on 1.1) | O-4b: the signing key present in every env of both projects | A missing key signs everyone out of that deployment (fails closed, by design) |
| 1.3 | MFA (server-checked) | P0 | Not started | — | — | — | — | — | — |
| 1.4 | Shared rate limiter (Upstash) | P0 | Partial | — | — | — | In-memory limiter on public routes only | Upstash (O-15) | — |
| 1.5 | Firewall + Turnstile | P1 | Not started | — | — | — | — | Cloudflare Turnstile, Vercel Firewall (O-16) | — |
| 1.6 | Retell signature on | P0 | Done | — | — | — | On `main` (e9745e0), live | — | — |
| 1.7 | No PII in logs | P1 | Not started | — | — | — | `offer-action.ts:133` still logs an email | — | — |
| 1.8 | DB pool, timeouts | P0 | Partial | Part 1: `poolOptions()` — `DB_POOL_MAX` (1–50, default 5), idle 20 s, connect 10 s, lifetime 30 min. Part 2 (`statement_timeout` per kind of work) not done: every app uses one DB role | `packages/db/src/pool-options.ts` (+ test), `client.ts`, `packages/config/src/env.ts`, `.env.example` | 4 tests; break-test (default → 2 fail); 8 parallel queries on dev through the pool; typecheck, lint, `pnpm test` green | `feat/1.8-db-pool` bec08c0 (stacked on the guard) | Load test sets the value (4.3) | Part 2 needs separate DB roles per kind of work |
| 1.9 | Compute size + CPU alert | P0 | Unverified | — | — | — | Dashboard | Supabase compute (O-14) | — |
| 1.10 | Indexes, first pass | P0 | Partial | — | — | — | 0097 indexes in production | — | — |
| 1.11 | pg_stat_statements weekly | P1 | Unverified | — | — | — | Supabase default; never reviewed | — | — |
| 1.12 | UUIDv7, lz4, pg_trgm | P1 | Not started | — | — | — | — | — | — |
| 1.13 | Migration rules | P1 | Not started | — | — | — | — | — | — |
| 1.14 | /api/health + uptime | P0 | Not started | — | — | — | — | — | — |
| 1.15 | Vendor fetch timeouts | P1 | Partial | — | — | — | 16 files with `AbortSignal.timeout` of 48 `fetch(` sites | — | — |
| 1.16 | error.tsx + API error shape | P1 | Partial | — | — | — | 5 `error.tsx` | — | — |
| 1.17 | V1 caps in env | P0 | Not started | — | — | — | — | — | — |
| 1.18 | Model prices | P1 | Not started | — | — | — | — | — | — |
| 1.19 | Pooler pool size | P0 | Not started | — | — | — | — | Supabase pool size (O-14) | — |
| 1.20 | Audit log | P1 | Not started | — | — | — | — | — | — |
| 1.21 | Upload byte checks | P1 | Partial | — | — | — | Size cap, header MIME, random keys, 60 s signed links | — | — |
| 1.22 | Session rules | P1 | Not started | — | — | — | — | — | — |
| 1.23 | Alert lines | P0 | Not started | — | — | — | — | — | — |
| 1.24 | AI budget in three pools | P0 | Built (branch) | Public (no agency), trial (agency status trial) and paying pools read in the one budget statement; public and trial ceilings below the platform cap, one trial agency's own share; unknown agency = public; new reason `pool_cap`; assistant refuses on any refusal (it let unknown reasons through); members' skills spend from their agency's pool | `packages/core/src/ai-budget/index.ts` (+ test), `assistant/budget.ts` (+ new test), `skills/runner.ts`, `.env.example` | 7 pool + 2 assistant tests; break-tests (pool check off → 4 fail; assistant mapping off → 1 fails); query run read-only on dev (valid SQL); typecheck, lint, `pnpm test` green | `feat/1.24-ai-budget-pools` a956b1a | D-3 values (env `AI_DAILY_BUDGET_USD_PUBLIC`, `_TRIAL`, `_TRIAL_PER_AGENCY`; defaults 20%/20%/$2) | Pipelines that write `ai_run` without an agency (e.g. visual embeddings) count as public; still a read-then-call budget (atomic only with 2.3) |
| 1.25 | Schema-version check | P1 | Not started | — | — | — | — | — | — |
| 2.1 | ADR plans/credits | P0 | Not started | — | — | — | — | — | — |
| 2.2 | Plan map | P0 | Not started | — | — | — | — | — | — |
| 2.3 | Credit ledger, atomic | P0 | Not started | — | — | — | — | — | — |
| 2.4 | Stripe Checkout + Portal | P0 | Blocked | — | — | — | Waits for prices (decision 2) | Prices (D-1), Stripe test account (O-17) | — |
| 2.5 | Stripe webhooks (order, async, refunds) | P0 | Not started | — | — | — | — | Stripe test account (O-17) | — |
| 2.6 | billing:manage + 80/100% emails | P0 | Not started | — | — | — | — | — | — |
| 2.7 | Admin cost page | P1 | Not started | — | — | — | — | — | — |
| 2.8 | Billing states | P0 | Not started | — | — | — | — | — | — |
| 2.9 | Daily reconciliation | P0 | Not started | — | — | — | — | — | — |
| 2.10 | Seat limits | P1 | Not started | — | — | — | — | — | — |
| 2.11 | Billing isolation | P0 | Not started | — | — | — | — | — | — |
| 3.1 | `job` table, retries, dead-letter | P0 | Partial | — | — | — | Tick runner, `SKIP LOCKED`, outbox; no retries or dead-letter | — | — |
| 3.2 | Webhooks through jobs | P1 | Partial | — | — | — | Twilio deduped by `provider_sid`; work done in the request | — | — |
| 3.3 | Fair SMS drain | P1 | Partial | — | — | — | SMS batches drained per tick; five SMS rules | — | — |
| 3.4 | Imports start no automations | P0 | Unverified | — | — | — | Imports write no `workflow_event`; trigger scans on changed contacts not checked | — | — |
| 3.5 | Vendor-down fallbacks | P1 | Not started | — | — | — | — | — | — |
| 3.6 | Priority lanes, vendor limiters | P1 | Not started | — | — | — | — | — | — |
| 3.7 | Unattended safety | P0 | Partial | — | — | — | Pause-all, five SMS rules, one run per event, email at-most-once | — | — |
| 3.8 | Inbound pull-back after outage | P1 | Not started | — | — | — | — | — | — |
| 3.9 | Late jobs, stuck claims reconciled | P1 | Not started | — | — | — | — | — | — |
| 3.10 | Twilio signature + token rotation | P1 | Not started | — | — | — | — | — | — |
| 4.1 | E2E five flows + four failures | P0 | Not started | — | — | — | — | — | — |
| 4.2 | Nightly smoke | P1 | Not started | — | — | — | — | — | — |
| 4.3 | Load, spike, soak, recovery | P0 | Not started | — | — | — | — | — | — |
| 4.4 | Restore drill, new project | P0 | Not started | — | — | — | — | A scratch Supabase project (O-19) | — |
| 4.5 | Accessibility | P1 | Not started | — | — | — | — | — | — |
| 4.6 | Devices | P1 | Not started | — | — | — | — | — | — |
| 4.7 | Route audit + ZAP | P1 | Partial | — | — | — | `isolation/entrypoints.test.ts` lists every route and action; no ZAP | — | — |
| 4.8 | Rollback drill | P1 | Not started | — | — | — | — | — | — |
| 4.9 | Isolation beyond pages | P0 | Partial | — | — | — | can() matrix + smoke 8/8; exports, jobs, files not covered | — | — |
| 4.10 | AI SQL probes in smoke | P1 | Partial | — | — | — | 6 smoke checks; 2026-11-18 dev probe not yet in smoke | — | — |
| 5.1 | Privacy policy | P0 | Not started | — | — | — | — | Lawyer (O-21) | — |
| 5.2 | Terms + DPA | P0 | Not started | — | — | — | — | Lawyer (O-21) | — |
| 5.3 | Breach runbook + runbooks | P0 | Not started | — | — | — | — | — | — |
| 5.4 | Secrets inventory | P1 | Not started | — | — | — | — | — | — |
| 5.5 | DNS, domains, cookie domain | P0 | Not started | — | — | — | — | DNS (O-22) | — |
| 5.6 | SPF/DKIM/DMARC, sender | P0 | Not started | — | — | — | — | DNS, Resend domain (O-22) | — |
| 5.7 | ACMA sender ID | P1 | Not started | — | — | — | — | ACMA (O-23) | — |
| 5.8 | Photo resize + EXIF | P1 | Partial | — | — | — | Inspection photos stripped (`photo-bytes.ts`); listing media not checked | — | — |
| 5.9 | Accounts in business name, 2FA | P0 | Not started | — | — | — | — | Boss (O-1) | — |
| 5.10 | Clean prod, support, status page | P1 | Not started | — | — | — | — | — | — |
| 5.11 | Data-flow doc, ADM disclosure, lawyer | P0 | Not started | — | — | — | — | Lawyer (O-21) | — |
| 5.12 | Agency export, deletion, purges | P1 | Partial | — | — | — | Only the chat retention purge runs; no agency export or deletion | — | — |
