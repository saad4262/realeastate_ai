# Runbooks (PLATFORM-PLAN 5.3)

What to do when something goes wrong, in order. Each one is tried once as a drill before launch; write the date and
what was wrong with the runbook under **Drills** at the end. Secrets are never written here (`SECRETS-INVENTORY.md`
says where each one lives).

**First, always:** write down the time, what you saw and who you told, in one note you keep for the incident. Two
people: one fixes, one writes and talks.

**Switches you can pull without a code change** (Vercel → project → Settings → Environment Variables → Production,
then **Redeploy**; an env change does nothing until a redeploy):

| Switch | Effect | Where |
|---|---|---|
| `SENDS_PAUSED=1` | Holds every queued text and bulk email (the job queue's send lane). Nothing is lost; unset it to release | web project (the tick runs there) |
| `AI_DAILY_BUDGET_USD=0` | Refuses every model call, platform-wide. `0` means zero; blank means the default | all four projects |
| `AI_DAILY_BUDGET_USD_PUBLIC=0` | Refuses only the public site's AI (the chat, research) | web project |
| `AI_DAILY_BUDGET_USD_TRIAL=0` | Refuses AI for trial agencies only | console projects |
| Suspend an agency | That agency only: no sign-in, no sends. Platform admin → the agency → Suspend (reason required, audited) | admin site |
| Pause one agency's sends | Automatic on a spike (3.7); an owner/admin resumes in Settings | — |

---

## 1. The app is broken after a deploy → roll back
Signs: `/api/health` not `ok`, error spike in Sentry, people cannot sign in, right after a merge to `main`.
1. Vercel → the broken project → Deployments → the last good one → **Instant Rollback** (or Promote). Do it for
   each of the four projects that broke (`realestate-ai-users`, `realeastate-ai-agent`, `realeastate-ai-agencyy`,
   `realeastate-ai-admin`). This takes about a minute and touches no data.
2. Check `https://<each domain>/api/health` → `{"status":"ok"}`.
3. **If the deploy came with a migration:** the old code must still work on the new schema. Our migrations only add
   (new tables, new nullable columns), so rolling the code back is safe. Never "un-migrate" by hand. If a migration
   itself damaged data, go to runbook 2.
4. `git revert` the merge on `main` (never force-push), open a fix branch, and re-deploy only after CI and a clean
   check pass.

## 2. The database is down, or data is damaged → restore
Signs: `/api/health` shows `database: error` everywhere; Supabase status page; rows missing or wrong.
1. **Down, not damaged:** check status.supabase.com and the project's dashboard. Wait it out; do not restore over a
   working database. `SENDS_PAUSED=1` if it lasts long enough that queued sends would go out late and confuse people.
2. **Damaged** (a bad migration, a bad script, deleted rows): stop the damage first: roll the code back (runbook 1),
   `SENDS_PAUSED=1`, and if needed `AI_DAILY_BUDGET_USD=0`.
3. Restore **into a new project**, never over production: `DEPLOY.md` → Backups → Restore, step by step. The newest
   backup is the 6-hourly one in S3 (or the encrypted local one taken before the last migration).
4. Point the four projects at the new project (the first five variables in "App secrets a restore needs"), redeploy,
   check `/api/health` and sign in.
5. Rows written between the backup and the damage are lost unless copied over by hand from the old project (it still
   exists: do not delete it for 30 days).
6. Write the time taken next to the RTO in PLATFORM-PLAN section 6.

## 3. A key leaked (in git, a log, a screenshot, a lost laptop)
1. **Rotate first, investigate after.** Find the key in `SECRETS-INVENTORY.md`: it says where to make a new one.
2. Put the new value in Vercel (every project that has it) and the password manager; redeploy; check health.
3. Revoke the old one at the provider (rotation without revoking leaves it working).
   - `INTEGRATION_TOKEN_KEY`: follow `DEPLOY.md` → "Rotating the key", and because it leaked, remove the previous key
     at once (everyone reconnects Google/Zoom).
   - `SUPABASE_SERVICE_ROLE_KEY` / database password: Supabase → Project Settings → API keys / Database → reset;
     update `DATABASE_URL`, `DIRECT_URL`, the GitHub backup secret.
   - `SESSION_HEADER_SECRET`: a new value signs everyone out of nothing (it only signs the forwarded identity); just
     rotate it.
4. A key in git: rotating is the fix. Rewriting history does not un-leak it (the repository is public).
5. Look for use: the provider's logs (Stripe, Twilio, Resend, Anthropic usage, Supabase logs) since the leak.
6. If anyone's personal information could have been reached with it: runbook 8.

## 4. A bot flood (sign-ups, enquiries, chat, scraping)
Signs: requests or AI spend climbing on the public site; many enquiries or sign-ups from few addresses.
1. Vercel → web project → Firewall → turn on **Attack Challenge Mode**; add a rule blocking the addresses or
   countries you see.
2. AI: `AI_DAILY_BUDGET_USD_PUBLIC=0` (the public chat and research stop; agencies keep theirs).
3. Supabase → Authentication → Rate Limits: lower sign-ups per hour for the duration.
4. Afterwards: delete the junk rows by script in a transaction (never by hand in the table editor), and note what
   would have stopped it (1.4 rate limits, 1.5 Turnstile).

## 5. The AI bill spikes
Signs: Anthropic usage page; the admin cost view; a spike pause email (3.7).
1. Find who: `ai_run` grouped by `agency_id` and `feature` for today (the admin cost page when 2.7 lands).
2. One agency: suspend it, or lower its cap; tell its owner why.
3. Everyone, or unknown: `AI_DAILY_BUDGET_USD=0`, redeploy, then investigate. The platform cap already stops the day
   at `AI_DAILY_BUDGET_USD`; check that it is set to what the owner agreed (D-3).
4. Check the Anthropic console's own spend limit is set (O-12); it is the last line if our cap fails.

## 6. A vendor is down (Twilio, Resend, Anthropic, Stripe, Google, Zoom, Supabase Storage)
1. Check the vendor's status page. Our calls time out (1.15) and fail per agency, not the whole site.
2. Twilio: texts stay `queued`; the stuck-SMS check (3.9) settles them when Twilio answers again, never sends twice.
   If it lasts hours, `SENDS_PAUSED=1` so a backlog does not go out at night.
3. Resend: bulk email batches stop and resume; transactional mail fails and is logged. Nothing to do but wait.
4. Anthropic: AI features show their "not available" message; nothing to do.
5. Stripe: webhooks are retried by Stripe for days; our events are stored once and replayed by the job queue. Check
   the admin dead letters afterwards.
6. Afterwards: platform admin → dead letters → replay what failed (each replay is recorded).

## 7. Lost access to an account (Vercel, Supabase, GitHub, domain, email, a vendor)
1. The accounts are in the business's name with 2FA and two owners (5.9). Ask the other owner first.
2. Use the recovery codes in the password manager (stored when 2FA was set up).
3. Provider support with business proof (ABN, invoices). Domain registrar first: whoever holds the domain holds email
   and sign-in for everything else.
4. Once back in: rotate every key that account could see (runbook 3), review its members and sessions.

## 8. A data breach (NDB scheme, OAIC)
The Notifiable Data Breaches scheme applies (D-7: we follow the APPs regardless of the small-business exemption).
1. **Contain** (minutes): the runbook for the cause: rotate keys (3), suspend an agency, roll back (1), close access.
2. **Assess** (start now, finish within 30 days, sooner is expected): what personal information, whose, how many
   people, could it cause serious harm (identity theft, financial loss, safety, humiliation)? Could remedial action
   prevent the harm (e.g. the data was recovered before anyone used it)? Write the assessment down as you go.
3. **Notify** if it is an eligible data breach (likely serious harm, not prevented): as soon as practicable, the OAIC
   (the online Notifiable Data Breach form at oaic.gov.au) **and** the affected individuals (directly, or a public
   notice if you cannot). Say what happened, what information, what we are doing, what they should do.
4. Agencies: tell each affected agency's owner; they may have their own duties to their clients.
5. **Review:** what let it happen, the fix, and update these runbooks.
Who decides: the boss, with the lawyer (O-21). The developer's job is the facts, fast and written down.

---

## Drills
| Date | Runbook | Who | What was wrong with the runbook |
|---|---|---|---|
| | 1 Rollback | | |
| | 2 Restore (= 4.4) | | |
| | 3 Key leaked | | |
| | 4 Bot flood | | |
| | 5 AI bill | | |
| | 6 Vendor down | | |
| | 7 Lost access | | |
| | 8 Breach (tabletop) | | |
| | 9 MFA recovery | | |

## 9. Someone lost their second factor (MFA recovery, PLATFORM-PLAN 1.22)
An owner, admin or platform admin whose phone (authenticator app) is lost or reset cannot reach billing, the team page
or platform controls once MFA is enforced.
1. **Prove it is them,** out of band: a call to the number on file for the agency, and an answer only they would know
   (their agency's ABN, a recent invoice amount). Never on the strength of an email alone: that is how accounts are
   taken over.
2. A platform admin removes the lost factor: Supabase → Authentication → Users → the person → MFA factors → delete
   (record who asked, who checked and when in the incident note).
3. Ask them to sign in, enrol a new factor at once, and change their password (which signs out every other device).
4. If it was an owner and the request looks wrong in any way, suspend the agency (Suspend on
   the agency from the admin site) until it is resolved.
