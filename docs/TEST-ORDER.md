# Test order — TEST-PLAN sections N to AC

Walk the sections of `docs/TEST-PLAN.md` in this order. The order is chosen so that:
- each section's data exists before a later section needs it;
- settings that need a restart change as few times as possible (one block per setting);
- removing a person (AC) comes last, because it changes who owns things.

Times are estimates for a careful first pass, including setup. They do not include fixing
anything you find. Every change to `.env.local` needs `pnpm dev` restarted; the blocks below
say when.

## Block 1 — no outside accounts (≈ 1 h 10 min)

Settings: as you have them now. Nothing extra.

| Order | Section | Needs | Time |
|---|---|---|---|
| 1 | **N** — Contacts | Owner + two agents in one agency | 15 min |
| 2 | **O** — Contact 360 | N's contacts | 15 min |
| 3 | **P** — Appointments | N's contacts | 20 min |
| 4 | **Y** — Import listings from a CSV | `GOOGLE_MAPS_API_KEY` (addresses are looked up); Supabase Storage for photos | 40 min |

Y fits here because it only needs the Maps key you already use for address search.

## Block 2 — pretend integrations and email (≈ 55 min)

Settings: `INTEGRATIONS_STUB=1` (the pretend Google/Zoom) and `INTEGRATION_TOKEN_KEY`. Email
needs `RESEND_API_KEY`, `ALERT_SENDER_ADDRESS`/`ALERT_SENDER_NAME`, and `EMAIL_DEV_ALLOWLIST`
covering every test contact's address (in dev, nothing else receives platform email). Restart.

| Order | Section | Needs | Time |
|---|---|---|---|
| 5 | **Q** — Integrations hub (stub) | `INTEGRATIONS_STUB=1` | 10 min |
| 6 | **R** — Skills | Q connected; `ANTHROPIC_API_KEY` for a skill run (a few cents) | 20 min |
| 7 | **S** — Template email to contacts | Resend + `EMAIL_DEV_ALLOWLIST`; contacts with marketing consent | 25 min |

## Block 3 — the assistant (≈ 1 h 30 min)

Settings: `ANTHROPIC_API_KEY` (each question costs a cent or two). Keep the Block 2 email
settings. Restart only if you changed something.

| Order | Section | Needs | Time |
|---|---|---|---|
| 8 | **U** — Assistant, read-only | Anthropic key | 15 min |
| 9 | **V** — Assistant changes you approve | Anthropic key; contacts from N | 30 min |
| 10 | **W** — Assistant template email | Anthropic key; S's approved template; `EMAIL_DEV_ALLOWLIST` | 20 min |
| 11 | **X** — Dashboards | Anthropic key; two sold listings with prices; a second agency's owner | 25 min |

## Block 3b — assistant search (≈ 35 min)

Settings: as Block 3 (`ANTHROPIC_API_KEY`). Embeddings are optional. For AD9 add
`EMBEDDINGS_PROVIDER=voyage` and `VOYAGE_API_KEY` to console and web settings, restart, and run
`pnpm --filter @repo/ai search:backfill` once. Without them, search works by words only.

| Order | Section | Needs | Time |
|---|---|---|---|
| 11b | **AD** — Assistant search in notes, emails and enquiries | Anthropic key; notes/emails/enquiries mentioning a word; a second agency's owner; optional Voyage key (AD9) | 35 min |

## Block 4 — Google's public data (≈ 20 min)

Settings: `GOOGLE_MAPS_API_KEY` with **Places API (New)** switched on in Google Cloud. That is
a separate switch from "Places API". No restart if the key is unchanged.

| Order | Section | Needs | Time |
|---|---|---|---|
| 12 | **Z** — Google reviews, step 1 | Places API (New); an agency with Google reviews to pick | 20 min |

## Block 5 — your real Google and Zoom accounts (≈ 1 h 20 min)

Settings: turn the stub **off** (`INTEGRATIONS_STUB` empty). Set `GOOGLE_OAUTH_CLIENT_ID` /
`GOOGLE_OAUTH_CLIENT_SECRET` and `ZOOM_OAUTH_CLIENT_ID` / `ZOOM_OAUTH_CLIENT_SECRET`. Add the
Gmail scope to the Google app's consent screen and enable the **Gmail API**. While the app is in
Testing, add every Google account you will use as a test user (tokens die after about 7 days).
Restart. Anything connected through the stub must be reconnected for real.

| Order | Section | Needs | Time |
|---|---|---|---|
| 13 | **T** — Real Google Calendar and Zoom | Real Google + Zoom accounts | 40 min |
| 14 | **AA** — Send from Gmail | Two real Gmail accounts (agent + "agency"); a contact inbox you can read; `EMAIL_DEV_ALLOWLIST` for invitations | 40 min |

## Block 6 — run it later (≈ 30 min, mostly waiting)

Settings: `ASSISTANT_SCHEDULING=1` in **both** the console and web settings. Something must call
`/api/cron/alerts` (with `CRON_SECRET`) every few minutes: the GitHub Actions pinger, or a
`curl` loop in a terminal. Restart.

| Order | Section | Needs | Time |
|---|---|---|---|
| 15 | **AB** — Assistant: approve now, run later | The flag + a cron caller; Anthropic key; for AB7, Block 2's email settings | 30 min |

## Block 7 — removing a person (≈ 45 min)

Settings: as in Block 5/6 (real Google/Zoom so events can be seen moving). Use agents you
don't need afterwards. The undo (AC7) brings them back, but their connections must be
redone.

| Order | Section | Needs | Time |
|---|---|---|---|
| 16 | **AC** — Removing someone from the agency | A1 with appointments (real Calendar/Zoom from T), contacts, a lead, an only-agent listing, a waiting assistant card, a prepared bulk email; A2 with Calendar connected; a second agency for AC11 | 45 min |

**Total: about 7 hours**, best spread over two sittings: Blocks 1–4, then 5–7.

## Every setting, in one place

The ones marked **new** were added in this round of work.

| Setting | Used by | Note |
|---|---|---|
| `DATABASE_URL`, `DIRECT_URL` | everything | as now |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_MEDIA_BUCKET` | sign-in, photos (incl. Y) | as now |
| `NEXT_PUBLIC_WEB_URL`, `NEXT_PUBLIC_AGENCY_URL`, `NEXT_PUBLIC_AGENT_URL`, `COOKIE_DOMAIN` | links, sign-in, OAuth return | as now |
| `GOOGLE_MAPS_API_KEY` | addresses, Y, **Z** | Z needs **Places API (New)** enabled on it |
| `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | maps in the browser | as now |
| `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_*_MODEL`) | assistant, skills, alerts | costs money per use |
| `AI_DAILY_BUDGET_USD`, `AI_DAILY_BUDGET_USD_PER_USER`, `AI_CHAT_DAILY_TURN_CAP` | cost caps | as now |
| `ASSISTANT_DAILY_BUDGET_USD_PER_USER`, `ASSISTANT_DAILY_BUDGET_USD_PER_AGENCY` | assistant caps | default $1 / $10 |
| **`EMBEDDINGS_PROVIDER`**, **`VOYAGE_API_KEY`** | **AD9** (optional) | `voyage` + a Voyage key turns on search by meaning; unset = by words only, never an error. Note and email text is sent to Voyage — client question 1 in ADR 0031 |
| **`EMBEDDINGS_DAILY_BUDGET_USD_PER_AGENCY`** | AD9 (optional) | Indexing cap per agency a day, default 0.25 (inside `AI_DAILY_BUDGET_USD`) |
| **`ASSISTANT_SCHEDULING`** | **AB** | `1` turns on "run later"; leave off until the 5-minute cron is live |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `ALERT_SENDER_ADDRESS`, `ALERT_SENDER_NAME`, `ALERT_EMAIL_FROM`, `ALERT_UNSUBSCRIBE_SECRET` | all platform email | as now |
| `MAIL_INBOUND_DOMAIN`, `MAIL_REPLY_SECRET` | replies back into the console (also for AA's Reply-To) | as now |
| `EMAIL_DEV_ALLOWLIST` | dev safety: only these addresses get platform-composed email | needed for S, W, AA, AB |
| `EMAIL_LIMIT_PER_AGENT_DAY`, `EMAIL_LIMIT_PER_AGENCY_DAY`, `EMAIL_LIMIT_PER_BATCH`, `EMAIL_REPEAT_DAYS`, `EMAIL_SEND_DELAY_MS` | sending limits | optional |
| `INTEGRATION_TOKEN_KEY` (+ `INTEGRATION_TOKEN_KEY_PREVIOUS` when rotating) | every connection; **Gmail** | required for Q, T, AA, AC |
| `INTEGRATIONS_STUB` | the pretend provider | `1` in Block 2, off in Block 5 |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Calendar **and Gmail** (one app) | add the `gmail.send` scope + Gmail API |
| `ZOOM_OAUTH_CLIENT_ID`, `ZOOM_OAUTH_CLIENT_SECRET`, `ZOOM_OAUTH_RETURN_BASE`, `INTEGRATION_OAUTH_RETURN_BASE` | Zoom / OAuth return | as now |
| `CRON_SECRET` | the scheduler (imports, Phase E, purges) | the pinger must send it |
| `REVALIDATE_SECRET` | console → website cache refresh | as now |
| `AGENT_INVITE_TTL_MINUTES`, `ALERTS_DRY_RUN` | optional | as now |
