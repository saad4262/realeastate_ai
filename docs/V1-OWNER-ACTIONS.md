# V1 owner actions

Everything here needs a person: a dashboard, an account, money, a decision or a signature. Claude Code does everything
else (`V1-IMPLEMENTATION-STATUS.md`). Never paste a secret into chat: put it straight into the dashboard or env named.

**Blocks** = later implementation waits for it. **Defer** = safe to leave until the stage named.

## Do first (this week)

| # | Action | Why | Where | Configuration | Blocks | Defer |
|---|---|---|---|---|---|---|
| O-1 | ✅ Done (2026-11-18/19: every approved branch merged and live). Review and merge the three open branches, in this order: `chore/dev-db-and-prod-guard`, `docs/platform-plan`, `ops/step-3-backups` (and each implementation PR as it comes) | Nothing built protects production until it is on `main`; the guard must be there before any later DB work | github.com/saad4262/realeastate_ai → Pull requests → New → base `main`, compare the branch → Create → wait for CI → Merge | — | Yes: stage 2 starts from `main` with the guard | No |
| O-2 | ~~Make the repository private~~ **Owner decision 2026-11-18: stays public for now.** Risk accepted: architecture and history are public; never commit a secret (gitleaks in CI) | It answers publicly today; backup secrets and the architecture must not be public | GitHub → repo → Settings → General → Danger Zone → Change visibility → Private | — | Yes, before O-9 (secrets) | No |
| O-3 | **Supabase Auth on our own SMTP** (production and dev) | The built-in sender reaches only team members, 2 an hour: password resets and sign-up emails never reach real agents | Supabase → project → Authentication → Emails → SMTP Settings → Enable custom SMTP | Resend SMTP: host `smtp.resend.com`, port 465, user `resend`, password = a Resend API key with sending access only; sender = a verified domain address. Then Authentication → Sign In / Providers → Email: confirm email ON | No | No (P0) |
| O-4 | **Separate preview secrets** | Preview deployments share production's `CRON_SECRET` and Retell keys | Vercel → each project → Settings → Environment Variables | Give Preview and Development their own `CRON_SECRET`, `REVALIDATE_SECRET`, token-encryption keys, Retell/Twilio **test** keys. Never edit the Production values. Then Settings → Deployment Protection → Vercel Authentication on for previews | No | Before stage 6 |
| O-4b | ✅ Checked 2026-11-18: present in every environment of all four projects. Confirm **`SUPABASE_SERVICE_ROLE_KEY`** (or a new `SESSION_HEADER_SECRET`, any long random value) is set in **every** environment of **both** Vercel projects before 1.2 is deployed | 1.2 signs the forwarded identity with it; without it that deployment treats everyone as signed out (fails closed) | Vercel → web and console → Settings → Environment Variables | Production, Preview, Development | 1.2 deploy | No |
| O-4c | ✅ Done by the owner 2026-11-18. **Sign in once on production** (agents/agency/admin) after the 2026-11-18 deploy | 1.2's signed header was verified for anonymous and forged requests, not for a real signed-in session | The production sites | — | No | Now |
| O-5 | Rotate the **dev** database password | Part of it was printed in a session log on 2026-11-17 | Supabase → realestate-dev → Project Settings → Database → Reset database password | Update `.env.dev`, `.env.local` (all checkouts) and Vercel Preview/Development `DATABASE_URL`/`DIRECT_URL` | No | No |
| O-5b | Delete the leftover secret files in `/Users/saadiii/Job/secure_backups/` (`env.local.production*`, `env.dev.before-pooler`) once their values are in the password manager; keep `backup-key.txt` only in the password manager | Production secrets on a laptop | Finder / password manager | — | No | No |
| O-5c | Point the other laptop's `.env.local` at dev | 0.1's proof: no laptop holds a production URL | That laptop | Copy dev values | No | No |

| O-26 | **Uptime and tick monitors** (after `feat/1.14-health` is merged) | Know before agencies do: the site is down, the database is unreachable or behind, or the scheduler stopped | An uptime service (e.g. healthchecks.io, Better Stack) and Vercel env | Monitor `https://agents.findoraaus.com.au/api/health` and `https://findoraaus.com.au/api/health` (expect 200). healthchecks.io check: period 1 min, grace 5 min → its ping URL as `HEALTHCHECK_TICK_URL` in the users project's Production env | No | Before launch |

## Backups (stage 1)

| # | Action | Why | Where | Configuration | Blocks | Defer |
|---|---|---|---|---|---|---|
| O-6 | Create an **age** key pair | Backups are encrypted to the public key; only the private key can read them | Terminal: `age-keygen -o backup-age.key` | Private key → password manager only (delete the file). Public key (`age1…`) → GitHub variable `BACKUP_AGE_RECIPIENT` | 0.4 going live | No |
| O-7 | **Separate AWS account** for backups | Losing or compromising the main accounts must not reach the backups | AWS Organizations or a new account; region **ap-southeast-4** (Melbourne) | Bucket with **versioning + Object Lock** (Governance, 14 days), lifecycle: noncurrent versions expire after 35 days; an IAM OIDC provider for `token.actions.githubusercontent.com` and a role trusted only for this repo's `main`, maximum session 5 hours (the first files copy), allowed `s3:PutObject`, `s3:ListBucket`, `s3:GetObject` (for the files copy's comparison) and `s3:DeleteObject` (creates delete markers only; versions stay locked) on that bucket | 0.4, 0.8 going live | No |
| O-8 | **healthchecks.io** check | An alert when a backup is missed or fails | healthchecks.io → Add Check | Period 6 h, grace 1 h (and a second check: period 1 day, grace 2 h for files) → email + phone | 0.4 alerts | No |
| O-9 | GitHub **secrets and variables** (after O-2) | The workflows read them | Repo → Settings → Secrets and variables → Actions | Secrets: `BACKUP_DATABASE_URL` (production **session pooler**, port 5432), `BACKUP_AWS_ROLE_ARN`, `BACKUP_HEALTHCHECK_URL`, `FILES_HEALTHCHECK_URL`, `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`. Variables: `BACKUP_AGE_RECIPIENT`, `BACKUP_S3_URI` (`s3://<bucket>/db/`), `BACKUP_FILES_S3_URI` (`s3://<bucket>/files`), `SUPABASE_S3_ENDPOINT`, then `BACKUP_ENABLED=true` last; Actions → Database backup → Run workflow once | 0.4/0.8 live | No |
| O-10 | **Supabase Storage S3 access keys** (dev first, for testing; then production for O-9) | The files copy reads the buckets through Supabase's S3 endpoint | Supabase → project → Storage → Settings (S3 Connection) → enable S3 protocol → New access key | Dev: put `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`, `SUPABASE_S3_ENDPOINT` (shown on the page) in `.env.dev` | 0.8 real test | No |

## Accounts and alarms (stage 1, P0)

| # | Action | Why | Where | Configuration | Blocks | Defer |
|---|---|---|---|---|---|---|
| O-11 | Branch protection on `main` | Every change through a PR and green CI | Repo → Settings → Branches → Add rule `main` | Require PR, require status check `CI`, no force push, no deletion | No | No |
| O-12 | **Hard spend stops** at every vendor | One bug or one abused agency must not run up an unbounded bill | Vercel → Team Settings → Billing → Spend Management · Supabase → Organization → Billing → Spend cap · Anthropic Console → Settings → Limits · Google Cloud → APIs & Services → Quotas · Twilio → Usage Triggers · Retell → billing limits | Values: decision D-2 | No | No (P0) |
| O-13 | **Sentry** projects and DSN | Errors reach us before customers do | sentry.io → Projects → create `web` and `console` → Settings → Client Keys (DSN) | Vercel env `NEXT_PUBLIC_SENTRY_DSN` per project (Production and Preview); alerts: new issue, 5xx spike | No | No (P0) |
| O-14 | Supabase **compute** and **pool size** (production) | 1.9, 1.19: Medium at launch; the default pool of 15 server connections is the real limit | Supabase → Project Settings → Compute and Disk; Database → Settings → Connection pooling → Pool Size | Medium; pool size per 1.19 after the load test (start ~60 on Medium) | Load test (4.3) | Until stage 8 |
| O-15 | **Upstash** Redis (Sydney) | The shared rate limiter (1.4) | console.upstash.com → Create database → region ap-southeast-2 | Vercel env `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (dev values in `.env.dev` too) | 1.4 live | Until stage 4 |
| O-16 | **Turnstile** and Vercel Firewall | Bots on sign-up, login, reset | Cloudflare → Turnstile → Add site; Vercel → project → Firewall | Env `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | 1.5 live | Until stage 4 |

## Billing (stage 7)

| # | Action | Why | Where | Configuration | Blocks | Defer |
|---|---|---|---|---|---|---|
| O-17 | **Stripe** account, **test mode** | Billing is built and tested with a fake Stripe; a real test-mode run needs this | dashboard.stripe.com (test mode) → Developers → API keys; Workbench → Webhooks → Add destination | `STRIPE_SECRET_KEY` (`sk_test_…`) in `.env.dev` and Vercel Preview only. Webhook URL `https://<preview or web host>/api/stripe/webhook`, events: `customer.subscription.created/updated/deleted`, `invoice.paid`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`; its `whsec_…` as `STRIPE_WEBHOOK_SECRET`. Products/prices per plan and top-up → `STRIPE_PRICE_*`; credits/seats → `PLAN_*`, `TOPUP_*` (.env.example). Settings → Customer emails: failed payments on | Real test-mode run of stage 7 | Until prices (D-1) |
| D-1 | **Decide prices and plans** (decision 2) | Code holds plan structure; the values are yours | — | Plan names, monthly prices, credits, seats, top-ups | 2.4 | Until week 5 |

## Decisions

| # | Decision | Recommended | Blocks |
|---|---|---|---|
| D-1 | Prices and plans (decision 2) | Section 13's proposal | 2.4 |
| D-2 | Vendor spend limits | Per section 12's V1 costs + 30% | O-12 |
| D-3 | AI pools (decision 13) | Public $30/day, trial $2 per agency/day, paying the rest | 1.24 values (code uses env defaults) |
| D-4 | Email limits (decision 3) | 150 per agent, 1,000 per agency a day | 1.17 values |
| D-5 | PITR (decisions 7, 10) | On before the first paying agency | 0.3 |
| D-6 | MFA for agents (decision 5) | Owners/admins at launch, agents in 3 months | 1.3 scope |
| D-7 | APPs regardless of exemption (decision 12); ADR 0083 wording (decision 8) | Yes; disclose with opt-out | 5.1 |
| D-8 | A closed agency's listings at deletion (ADR 0093) — **decided 2026-11-19: keep (archive)** | Kept in an "archived listings" agency, withdrawn, no agent names, so buyers' shortlists/notes and sales history survive. The alternative deletes them and those buyers lose them | 5.12 |

## Launch (stage 9)

| # | Action | Why | Where | Blocks | Defer |
|---|---|---|---|---|---|
| O-18 | Accounts in the business's name, 2FA everywhere, shared password manager, registrar lock (5.9) | Losing one person must not lose the platform | Each vendor | No | Before launch |
| O-19 | A **scratch Supabase project** for the restore drill (4.4) | A restore is never tried on production or dev | Supabase → New project (Sydney, Micro), deleted after the drill | 4.4 | Until stage 8 |
| O-20 | Production migrations and deploys | Each needs your explicit "go"; one runs, one watches | — | Each production step | — |
| O-21 | Lawyer: privacy policy (with automated decisions, from 10 Dec 2026), terms, DPA, data-flow document (5.1, 5.2, 5.11) | Legal approval is yours | — | Launch | Start by week 3 |
| O-22 | DNS (Cloudflare, DNS only), domains on Vercel, Resend domain with SPF/DKIM/DMARC, `COOKIE_DOMAIN` (5.5, 5.6) | Mail deliverability, the three hosts | Cloudflare, Vercel, Resend | Launch | Before launch |
| O-23 | ACMA SMS sender ID registration (5.7) | Unregistered sender IDs show as "Unverified" | ACMA SMS Sender ID Register | SMS selling | Before SMS sells |
| O-24 | Microsoft Entra publisher verification; copy `docs/SECRETS-INVENTORY.md` into the password manager and fill each **expiry date** (the Entra client secret expires; set a reminder a month before) | Outlook connections; expiring secrets | Entra admin centre; password manager | No | Before launch |
| O-27 | **E2E in CI** (4.1): repository variable `E2E_ENABLED=true`; variables `E2E_WEB`, `E2E_AGENT`, `E2E_AGENCY` = stable preview URLs pointed at the **dev** project with vendors faked; secrets `E2E_DIRECT_URL`, `E2E_SUPABASE_URL`, `E2E_SERVICE_ROLE_KEY`, `E2E_STRIPE_WEBHOOK_SECRET` (all **dev** values) | "CI fails when a flow breaks" needs a target | GitHub → Settings → Secrets and variables → Actions; Vercel previews (a console preview per surface via `CONSOLE_SURFACE_OVERRIDE`) | 4.1 in CI | Before launch |
| O-28 | **Load-test day** (4.3): raise the dev database to production's compute for one day, a preview on dev with vendors faked; I run `load/README.md` and record the numbers, then you lower the compute Also proves 3.3 (200 agencies' 9 am SMS drain) and 3.6 (a page and a webhook within budget during it). | Section 5 must hold at V2 numbers before launch | Supabase → dev → Compute | 4.3 done, 1.8/1.19 values | Before launch |
| O-29 | **Runbook drills** (5.3): each runbook in `docs/RUNBOOKS.md` tried once, with me; breach runbook as a tabletop with the lawyer | An untried runbook fails when it is needed | — | 5.3 done | Before launch |
| O-30 | **Restore drill** (4.4) needs O-19's scratch project; rollback drill (4.8) is a Vercel Instant Rollback on a quiet evening | Recovery proven, not assumed | Supabase, Vercel | 4.4, 4.8 | Before launch |
| O-31 | **Supabase session settings** (1.22), production and dev | A stolen token works for at most 15 minutes; an idle session ends | Supabase → Authentication → Sessions (and JWT settings) | JWT expiry **900** s; inactivity timeout **7 days**; refresh-token rotation and reuse detection **on** (the default) | 1.22 complete | Before launch |
| O-32 | **V1 caps in Vercel Production** (1.17, decisions D-2/D-3/D-4) | Today's platform AI cap runs out within hours at V1 numbers | Vercel → each project → Settings → Environment Variables → Production, then Redeploy | `AI_DAILY_BUDGET_USD=300`, `AI_DAILY_BUDGET_USD_PER_USER=0.25`, `ASSISTANT_DAILY_BUDGET_USD_PER_USER=1.50`, `EMAIL_LIMIT_PER_AGENT_DAY=150`, `EMAIL_LIMIT_PER_AGENCY_DAY=1000`, `SMS_LIMIT_PER_AGENT_DAY=100` (or your own values); I can set them if you say so | 1.17 done | Before the first agencies |
| O-33 | **Uptime monitor on `/api/health/alerts`** (1.23), paging a phone | Job lag, dead jobs, stuck texts and spike pauses reach you at night | The same uptime tool as O-26 | `https://findoraaus.com.au/api/health/alerts`, alert when not 200 twice; and the rest of the table in `DEPLOY.md` → Alert lines (Sentry, Supabase) | 1.23 done | Before launch |
| O-34 | **The Monday slow-query look** (1.11). Decided 2026-11-20: you run it, or ask me for a single run; no standing production access | The slowest statements are found before customers feel them | Terminal, production `DIRECT_URL` | `CONFIRM_PRODUCTION=<ref> pnpm --filter @repo/db db:slow-queries`, the table pasted into `docs/SESSION.md` | 1.11's first report | Now: 0104 is live (2026-11-20) |
| O-25 | Final go/no-go and the production launch approval | Yours alone | — | Launch | — |
| O-35 | **Switch on the nightly smoke** (4.2): repository variable `SMOKE_NIGHTLY_ENABLED=true`; secrets `SMOKE_DATABASE_URL`, `SMOKE_DIRECT_URL`, `SMOKE_SUPABASE_URL`, `SMOKE_SUPABASE_PUBLISHABLE_KEY`, `SMOKE_SERVICE_ROLE_KEY` (all DEV values); optionally `SMOKE_HEALTHCHECK_URL` | A check that goes red is seen the next morning | GitHub → Settings → Secrets and variables → Actions; healthchecks.io | Run it once by hand (Actions → Smoke (nightly) → Run workflow) and send me the result | 4.2 | **Now**: merged 2026-11-20 (8c7dd25); the four stale checks are fixed, so the first night should be green |
| O-36 | **Twilio outage drill** (3.8), when a dev Twilio number exists: point it at dev, make the dev webhook answer 503 (or switch dev off), send it two texts and ring it once, bring dev back | Proves texts and calls sent while we were down reach the CRM | A dev Twilio number; dev env | Tell me when it is set up; I run `phone:pull-inbound 1` on dev and show the result | 3.8 | Before launch |
| O-37 | **Switch on MFA** (1.3) after the UI batch is live: set yourself up on /security (Settings → Security) with an authenticator app, then `MFA_ENFORCED=1` in Vercel Production for the console projects, redeploy | Owners, admins and platform admins need a code for team, billing and platform changes | An authenticator app; Vercel (console projects) | Tell me when it is set; I check /team asks for the code | 1.3, 1.22 | After the UI merge |
| O-38 | ~~**The sign-in page's claims**~~ Done 2026-11-20 (owner: remove all four; live a83a190): it says "ISO 27001 Certified", "256-bit AES", "NSW Property and Stock Agents Act 2002 Compliant" and "Sydney Metro Datacenter: 14ms" (from the design mock). Keep only what is true | A claim we cannot back is misleading conduct (Australian Consumer Law) | Your decision; the lawyer if unsure | Tell me which to keep; I change the page | 4.5 (found) | Before launch |
| O-39 | **Five minutes on real phones** (4.6): an iPhone with Safari and an Android phone with Chrome on mobile data: sign in to the console, open the menu, send an enquiry on a listing | Emulation covers the engine and the screen, not the handset (keyboard, real network) | Two phones | Tick TEST-PLAN rows G2.6 and G2.7, or tell me what looked wrong | 4.6 | Before launch |
| O-40 | **The agency AI page's made-up figures** (`/ai`): "148 data points/sec", "GPT-RealEstate-2030", "22ms Mesh", "Autonomous v4.9 Active" and the like are from the design mock, not from SQL (CLAUDE.md: numbers come from SQL or are not shown) | Agencies may read them as real | Your decision | Tell me: remove them, or replace with real counts | Found by the O-38 scan | Before launch |
| O-41 | **Go for the sign-out fix** `fix/sign-out-both-cookies` (no migration): merge, clean-copy checks, deploy, and the same production checks | Sign out leaves the browser signed out after a session refresh | — | Say "go" | 1.22 | Now |
