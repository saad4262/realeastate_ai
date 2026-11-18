# V1 owner actions

Everything here needs a person: a dashboard, an account, money, a decision or a signature. Claude Code does everything
else (`V1-IMPLEMENTATION-STATUS.md`). Never paste a secret into chat: put it straight into the dashboard or env named.

**Blocks** = later implementation waits for it. **Defer** = safe to leave until the stage named.

## Do first (this week)

| # | Action | Why | Where | Configuration | Blocks | Defer |
|---|---|---|---|---|---|---|
| O-1 | Review and merge the three open branches, in this order: `chore/dev-db-and-prod-guard`, `docs/platform-plan`, `ops/step-3-backups` (and each implementation PR as it comes) | Nothing built protects production until it is on `main`; the guard must be there before any later DB work | github.com/saad4262/realeastate_ai → Pull requests → New → base `main`, compare the branch → Create → wait for CI → Merge | — | Yes: stage 2 starts from `main` with the guard | No |
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

## Launch (stage 9)

| # | Action | Why | Where | Blocks | Defer |
|---|---|---|---|---|---|
| O-18 | Accounts in the business's name, 2FA everywhere, shared password manager, registrar lock (5.9) | Losing one person must not lose the platform | Each vendor | No | Before launch |
| O-19 | A **scratch Supabase project** for the restore drill (4.4) | A restore is never tried on production or dev | Supabase → New project (Sydney, Micro), deleted after the drill | 4.4 | Until stage 8 |
| O-20 | Production migrations and deploys | Each needs your explicit "go"; one runs, one watches | — | Each production step | — |
| O-21 | Lawyer: privacy policy (with automated decisions, from 10 Dec 2026), terms, DPA, data-flow document (5.1, 5.2, 5.11) | Legal approval is yours | — | Launch | Start by week 3 |
| O-22 | DNS (Cloudflare, DNS only), domains on Vercel, Resend domain with SPF/DKIM/DMARC, `COOKIE_DOMAIN` (5.5, 5.6) | Mail deliverability, the three hosts | Cloudflare, Vercel, Resend | Launch | Before launch |
| O-23 | ACMA SMS sender ID registration (5.7) | Unregistered sender IDs show as "Unverified" | ACMA SMS Sender ID Register | SMS selling | Before SMS sells |
| O-24 | Microsoft Entra publisher verification; secrets inventory with expiry dates (5.4) | Outlook connections; expiring secrets | Entra admin centre; password manager | No | Before launch |
| O-25 | Final go/no-go and the production launch approval | Yours alone | — | Launch | — |
