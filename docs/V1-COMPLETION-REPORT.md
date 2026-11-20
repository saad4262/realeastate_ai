# V1 completion report (mission section 10), updated 2026-11-20

**Status: not complete, and not production-ready.** 45 of 80 tasks are done. **Every code task that can be
built and proven without the owner, a vendor account or Cursor is now done, except the four listed under "Code" in
A.** The rest waits on the owner, a lawyer or Cursor. Sources: `V1-IMPLEMENTATION-STATUS.md` (each task, with
evidence) and `V1-OWNER-ACTIONS.md`.

## A. Implementation summary

| | Tasks | Which |
|---|---|---|
| Total in the roadmap (14.12) | **80** | |
| Done (merged, live where it applies, proof held) | **46** | 0.1 0.2 0.12 · 1.1 1.2 1.3 1.6 1.7 1.10–1.15 1.17 1.18 1.20–1.25 · 2.1 2.2 2.3 2.6 2.8–2.11 · 3.1–3.5 3.7–3.10 · 4.1 4.2 4.9 4.10 · 5.3 5.4 5.12 |
| Live, waiting on a vendor test | **2** | 2.4, 2.5 (Stripe test mode: O-17) |
| Built, waiting to be switched on, run or merged | **4** | 0.4, 0.8 (off-site backups: O-6…O-10) · 4.3 (load scripts live; the runs need O-28) · 4.7 (`fix/4.7-zap-findings`, waiting for the owner's go) |
| Partial / unverified | **10** | 0.5 0.6 0.7 0.10 · 1.4 1.8 1.9 1.16 · 3.6 · 5.8 |
| Blocked | **1** | 0.3 PITR (decision 7: off for now) |
| Not started | **17** | 0.9 0.11 · 1.5 1.19 · 2.7 · 4.4 4.5 4.6 4.8 · 5.1 5.2 5.5 5.6 5.7 5.9 5.10 5.11 |

Straight count: **46 / 80 done (57%)**, up from 31 on 2026-11-19.

**Not finished, by who can move it:**
- **Code (Claude Code: can continue now, nothing needed from anyone).**
  The final backend batch is built and waiting for the owner's go (production untouched):
  1. `fix/0094-pooler-v2` 4cc8aec: the `/platform` pooler hang (ADR 0094 second attempt) + migration 0106.
  2. `fix/4.7-zap-findings` 8b482a5: 4.7's ZAP findings.
  3. 3.1 closed as Done, without moving the older job types (not low-risk).
  4. 1.8 part 2 deferred past V1 (owner, 2026-11-20).
- **Code that needs an owner account or event first:** 1.4 (Upstash, O-15), 1.5 (Turnstile, O-16), 1.19/1.9
  (pool size, compute: O-14), 2.4/2.5 (Stripe test mode, O-17), 3.6's spike test and 4.3 (load-test day, O-28), 4.4
  (O-19), 4.8 (O-30), 3.8's live drill (O-36), 4.2 switched on (O-35).
- **Cursor (UI):** 1.3 MFA setup screen, 1.22 "Sign out of all devices", self-hosted Google Fonts, 2.7 admin cost
  page, the delete-account page, 4.5 accessibility, 4.6 devices, 5.8 photo resize, 1.16 error pages.
- **Owner, lawyer or a vendor:** 0.3, 0.5, 0.6, 0.7, 0.9 (repo stays public by decision), 0.10, 0.11, 5.1, 5.2,
  5.5, 5.6, 5.7, 5.9, 5.10, 5.11.

## B. Technical changes (2026-11-18 → 2026-11-19, `main` e9745e0 → f818d1a)

**28 merges** to `main`, each approved. **195 files**, +6,712 / −231 lines (excluding generated migration snapshots
and the lockfile). Most of the work is in `packages/core` (78 files), `apps/web` (27), `packages/db` (23) and
`apps/console` (18).

**Migrations created (all applied to production after a verified encrypted backup, each with the owner's go):**

| Migration | What | Production |
|---|---|---|
| 0098 `audit_log` | Agency audit log (1.20) | 2026-11-18 |
| 0099 `workflow_event_retries` | Retries and dead letters for workflow events (3.1) | 2026-11-18 |
| 0100 `job_queue` | The `job` table: lanes, fair share per agency, lease, retries, dead letters (3.1) | 2026-11-18 |
| 0101 `agency_sends_pause` | An agency's sends paused by the spike check (3.7) | 2026-11-18 |
| 0102 `billing_credits` | Credit grants and holds, Stripe events, agency billing columns (2.3) | 2026-11-19 |

**Features:**
- Auth outage → 503 (1.1)
- Signed session header (1.2)
- AI budget pools (1.24, 1.8)
- Audit log (1.20)
- Health endpoint and tick dead-man ping (1.14/1.25)
- Job queue with dead letters and admin replay (3.1)
- Stuck-SMS reconcile and late-work rules (3.9)
- Unattended-safety spike pause (3.7)
- Billing:
  - plan map (2.2)
  - atomic credit ledger (2.3)
  - Stripe Checkout, Portal and webhooks through the queue (2.4/2.5/2.11)
  - billing holds (2.8)
  - daily reconciliation (2.9)
  - seat limits (2.10)
  - 80%/100% credit alerts (2.6)
- Agency close, export and delete (5.12, ADR 0093)
- Public account self-deletion and the daily retention purge (5.12)

**Security:**
- PII removed from logs, with a scan in tests (1.7)
- Every vendor call has a timeout (1.15)
- Uploads checked against their bytes (1.21)
- gitleaks and Dependabot; CI fails on a critical advisory (0.5)
- Production guard on every script (0.2)
- The SMS reconcile job is scoped to its own agency (4.9)
- AI SQL probes in smoke (4.10)
- Exports drop secrets and buyers' data (ADR 0093)

**Infrastructure and operations:**
- Backup and restore procedure (0.8/0.12)
- Runbooks (5.3)
- Secrets inventory (5.4)
- k6 load suite (4.3)
- Playwright E2E with a CI workflow (4.1)
- Vercel env (owner-authorised): AI pool caps (trial 10, public 10, trial per agency 5)

**ADRs:**
- 0092: plans, credits and Stripe
- 0093: agency closure

## B2. Technical changes (2026-11-20, `main` f818d1a → 8c7dd25)

Each merge was approved by the owner. Each production migration ran after a verified encrypted backup.

- **5501c9e:** 1.3 MFA (server side), 1.22 sessions, 1.23 alert lines, 1.17 V1 caps documented. Production caps
  are kept low until launch (owner).
- **4667916, reverted in db76874:** the pooler fix for the `/platform` hang (ADR 0094).
  - The patched driver deadlocked with a small pool.
  - The production minute tick hung for about 7 hours with sessions idle in transaction. Nothing was lost.
  - The fix is deferred; a retry must be tested at pool sizes 1, 2 and 5.
- **3ad29ec:** 1.10, 34 foreign-key indexes (migration 0103).
- **1f794c2:** 1.11–1.13 (migration 0104):
  - `pg_stat_statements` report, index advisor, `uuid_v7()` ids on 29 growing tables, lz4;
  - trigram contact search;
  - migration rules: 1 s lock timeout, concurrent-index script.
- **8c7dd25 (`integrate/v1-3x`):**
  - 3.10: Twilio signature on managed numbers and auth-token rotation (migration 0105).
  - 3.5: email retry under one idempotency key, a labelled template draft when the model is down, agents told of
    texts Twilio did not take.
  - 3.6: held sends spread over the opening's first 5 minutes; Retry-After honoured.
  - 3.8: pull-back of texts and calls missed during an outage.
  - 3.2: webhooks answer first; Retell deduplicated.
  - 3.3: fair SMS drain by agency.
  - 3.4: imports start no automation; behaviour change approved.
  - 4.2: nightly smoke workflow, and four stale smoke checks fixed.
  - **A real bug found on the way:** batch approval checked expiry on two clocks and could silently not approve.

Migrations applied to production today: **0103, 0104, 0105** (106 in all).

## C. Testing evidence (actual results)

| Kind | Result |
|---|---|
| Unit | On `main` 8c7dd25 in a clean worktree: **all passed, 0 failed** (core 2,429 · ai 462 · auth, db, ui). No network, no live AI |
| Type checks | `pnpm typecheck`: all packages pass (11 with `@repo/e2e` on its branch) |
| Lint | `pnpm lint`: **0 errors**, 1 warning (`<img>` in web, older than this work) |
| Build | Vercel production builds: **success** on all four projects for every merge, last f818d1a. Five old console/web projects fail, as they did before this work |
| Integration (live, dev database) | Smoke groups added and run alone: AI SQL probes (passed, 50 s), Isolation beyond pages (passed, 51 s), Agency closure (passed, 215 s), Account deletion and retention (passed, 34 s). Each change was proven on dev with a script or smoke group |
| Break-tests (each guard removed → the check went red) | One or more for every guard built, including: credit lock (12 passed, −10 balance), seat lock (3 active), grant before paid, no-grace hold, reconciliation, credit alerts (re-send, admin mailed), job agency guard, import/document agency filters, token unredacted, shortlist exported, agent account deletion (sign-in deleted, row refused), trash 0 days, contact agency filter (E2E red) |
| E2E | `packages/e2e` against local dev servers on the dev database: **6 passed** (sign in, enquiry reaching the agent, publish, import, cross-agency URL refused, duplicate webhook queued once). **3 pending** with reasons (assistant needs a fake-model switch; failed payment needs O-17; wrong MFA needs 1.3). Not yet in CI (O-27) |
| Security | Every CI run has gitleaks over the full history and `pnpm audit` for critical advisories. Isolation sweep (every read as A against B's ids). AI SQL probes. Webhook signature tests. Unsigned Stripe webhook on production → 400 |
| Load | Only a **30 s smoke** of the k6 suite against a local dev server (75 requests, 0 errors; the thresholds were evaluated and can fail). **The 60 min load, spike, soak and V2 runs have not been done** (O-28) |
| Recovery | **Not done:** the restore drill (4.4) and rollback drill (4.8) need O-19/O-30. Done: 5 encrypted production backups (one before each production migration), each fully decrypted and read back (latest 142 tables) |
| Integration (2026-11-20, dev) | The batch on `integrate/v1-3x`: smoke Phone, Workflows and SMS groups **22/22 passed**; each new check break-tested red (3.10, 3.5 ×2, 3.8, 3.2, 3.3, 3.4, the fixed 4.2 checks) |
| Production checks | After every deploy: `/api/health` ok on all four domains (schema ok), `/api/health/alerts` ok; after 8c7dd25, 0 sessions idle in transaction over 3.5 min and the tick completing each minute |

## D. Remaining owner actions (only what needs a person)

From `V1-OWNER-ACTIONS.md`, most urgent first:

1. **O-5:** rotate the dev database password. **O-5b:** delete the production env copies from the laptop.
2. **O-26:** set `HEALTHCHECK_TICK_URL` and the uptime monitors. **O-13:** Sentry DSN. **O-12:** a hard spend stop at
   every vendor.
3. **O-6…O-10:** backup accounts (age key, AWS, healthchecks, GitHub secrets, Storage S3 keys) so off-site backups
   run. **D-5:** PITR before the first paying agency.
4. **O-3:** Supabase Auth on our SMTP (password reset emails reach real agents). **O-4:** separate preview secrets.
5. **O-11:** branch protection on `main`. **O-14:** production compute and pool size.
6. **O-17 + D-1:** Stripe test keys and prices; then I run billing against Stripe test mode.
7. **O-15/O-16:** Upstash and Turnstile, so I can build 1.4/1.5.
8. **O-27:** E2E secrets and variables. **O-28:** the load-test day. **O-19/O-30:** scratch project for the restore
   drill. **O-29:** runbook drills.
9. **O-21:** lawyer: privacy policy (automated-decision disclosure from 10 Dec 2026), terms, DPA, data-flow
   document.
10. **O-22:** DNS, SPF/DKIM/DMARC, cookie domain. **O-23:** ACMA sender ID. **O-18:** accounts in the business's
    name with 2FA. **O-24:** Entra verification and secret expiry dates.
11. **O-25:** final go/no-go.

## E. Remaining risks

**Security**
- MFA is enforced on the server (1.3); its setup screen is Cursor's.
- No shared rate limiter or bot check on sign-up, login and reset (1.4/1.5). Vercel Firewall is the stopgap
  (runbook 4).
- The repository is public (accepted by the owner).
- Preview deployments share some production secrets (O-4).
- The dev password was once printed in a log (O-5).
- Production env copies are on a laptop (O-5b).
- Session rules (1.22) are merged; the Supabase settings are O-31.

**Reliability**
- Off-site backups are built but not running (O-6…O-10).
- PITR is off: up to 24 h of data could be lost (Supabase daily backup only).
- A restore has never been drilled.
- No load run at V2 numbers.
- Pooler size and compute are at their defaults (1.9/1.19).
- No Sentry DSN (O-13); the alert lines (1.23) are live but no monitor pages anyone yet (O-33); the tick dead-man ping is not set (O-26).
- The `/platform` admin home can hang through the pooler (ADR 0094); the fix was reverted after it deadlocked the tick and waits for a correct one.
- Twilio's auth-token rotation (3.10) has not been run against a real managed account (none exists yet).
- The nightly smoke is built but off until O-35.

**Billing**
- Never run against real Stripe (test mode needs O-17); prices undecided (D-1).
- Extra purchased seats are not modelled.
- Assistant turns reserve credits per round (conservative).
- Failed-payment emails rely on Stripe's own settings.
- Today no agency is on a paid plan, so none of it is live in effect.

**Operational**
- Runbooks not yet drilled.
- Two people.
- Vendor spend stops unverified (O-12).
- The admin cost page (2.7) is not built.

**Legal**
- No privacy policy, terms or DPA (O-21).
- The automated-decision disclosure is due 10 Dec 2026.
- ACMA sender ID not registered.
- Auth emails are not on our SMTP (0.10).
- The breach process is written but untried.

## F. Launch readiness

| Area | State |
|---|---|
| Tenant isolation (pages, exports, files, jobs, AI SQL) | **Verified** (smoke sweeps, E2E, break-tests) |
| Audit log, PII-free logs, vendor timeouts, upload checks | **Verified** |
| Job queue, dead letters, stuck-SMS reconcile, spike pause | **Verified** on dev and live |
| AI budgets and credits | **Verified** on dev; live (no paid agency yet) |
| Billing with Stripe | **Implemented but unverified** against real Stripe (O-17) |
| Agency export/deletion, account self-deletion, retention | **Verified** on dev; live (no UI for self-deletion yet) |
| Health endpoint | **Verified**; monitors **not set up** (O-26) |
| Backups | Local encrypted: **verified**. Off-site: **implemented but not enabled**. Restore: **unverified** |
| Load and recovery | **Implemented but unverified** (scripts only) |
| E2E | **Verified locally**; CI **blocked** on O-27 |
| MFA, sessions | **Implemented** (server); setup screens with Cursor |
| Rate limiting, bot protection | **Not implemented** (1.4/1.5 blocked on O-15/O-16) |
| Error monitoring and alerts | Sentry **blocked** (O-13); alert lines **live**, monitor not set (O-33) |
| Vendor outages, webhooks, peak shaping (3.2–3.8, 3.10) | **Verified** on dev and live; load proof on the load-test day (O-28) |
| Legal (privacy, terms, DPA, ADM, ACMA) | **Blocked** (lawyer, O-21/O-23) |
| DNS, email authentication, domains | **Blocked** (O-22) |

**Verdict:** the core of the platform (isolation, money paths, unattended work, data lifecycle) is built, proven and
live. **It is not ready to launch:** rate limiting and bot protection, monitoring, off-site backups, a restore drill, a
V2 load run, the MFA setup screen, and the legal documents are each a launch blocker.
