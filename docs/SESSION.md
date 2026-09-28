## 2026-09-28 — Claude Code — every run emails, including the ones with no news

- Goal: asked for, explicitly: an email at every scheduled time whether or not anything new
  turned up. The `newIds.length === 0` early return in `runOneSchedule` is gone.
- Files touched: `packages/core/src/schedules/run-schedule.ts`, `apps/web/app/alerts/page.tsx`,
  `packages/smoke/src/index.ts`, `docs/STATUS.md`, `docs/TEST-PLAN.md`

### The old reasoning is kept in the comment, not deleted

It was not wrong — a recurring "no change" message is the fastest way to teach somebody to
mute a sender, and enough spam complaints take the sending domain down for the digests that
DO carry news. But it is the product owner's call, and the legal position holds either way:
the recipient created the schedule themselves (that is the Spam Act's consent), and every
message still carries sender identity, postal address and a working one-click unsubscribe.
Lawful; whether it is wise is a judgement about their own list. The comment says so, so
nobody re-litigates it from scratch in six months.

### Two facts, two columns

`status` still means what the SEARCH found — `empty` when nothing was new — and
`email_status` means what happened to the message. An emailed run that found nothing is
`status: 'empty'`, `email_status: 'sent'`. Keeping them separate matters in two places:

- `claimDueSchedules` anchors the "what is new" diff on the last **delivered** run, so the
  baseline still only advances when there genuinely was news. Collapsing everything to
  `delivered` would have made a withdrawn-and-relisted property count as new.
- `/alerts` promises "everything we have sent", so it now filters on `email_status = 'sent'`
  rather than `status = 'delivered'`. Historical rows read correctly too: the old empty runs
  recorded `skipped`, and no email was sent for them.

### No prose for a digest with no news

The model call is skipped when `newCount === 0`. `templateSummary` already writes the right
sentence — "No new listings since we last looked. 3 still match …" — and there is nothing
for a model to add. It matters at this cadence: a 10-minute schedule is 144 runs a day, and
paying for a paragraph on the ~140 that say "nothing changed" is the entire per-user budget
spent on the least interesting sentence in the product.

### Verified on the real schedule

    { "claimed": 1, "delivered": 0, "empty": 1, "emailsSent": 1, "emailsSkipped": 0 }

    status: 'empty'  new_count: 0  email_status: 'sent'
    emailed_at: 2026-09-28T07:03:11Z  recipient: mohad@gmail.com

A real email went to a real address. Resend's domain `quotemydecking.com.au` was confirmed
`verified` / `sending: enabled` first, and a digest built from live rows had already been
accepted by Resend via their `delivered@resend.dev` simulator.

New smoke check: two ticks against an unchanged database must produce two emails, the second
subjected "No new listings". Broken on purpose (§ 12) by restoring the skip — went red with
"1 email(s) for 2 runs".

### One interrupted tick, and the sweeper earning its keep

A `running` row appeared on the live schedule for the 06:52 slot and never finished — a tick
that claimed and then died, which is exactly the case `sweepAbandonedRuns` was written for
last session. It was swept. Worth stating the consequence now that every run emails: an
interrupted tick is one missed email, because the cursor advances inside the claim
transaction and that slot never comes back. The next slot sends normally.

- Left unfinished (exact next step): nothing on localhost ticks the cron, so "every 10
  minutes" is every 10 minutes only where something pokes `/api/cron/alerts`.
- Risks / watch: the Spam Act footer is still `Test Company` / `123 Test St, Test City`, and
  the cadence change makes that more pressing, not less — there is simply more mail now.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10
- `pnpm test` — 597 (414 `@repo/core`, 183 `@repo/ai`)
- `pnpm smoke` — **95 passed, 0 failed**, 10 skipped

## 2026-09-28 — Claude Code — editing a schedule, and a sender address that is one

- Goal: let somebody change a saved search's time after the fact, and make the alert
  sender address correct by default.
- Files touched: `apps/web/components/{schedule-picker.tsx,save-search.tsx}`,
  `apps/web/app/alerts/{schedule-row.tsx,page.tsx,actions.ts}`,
  `packages/core/src/email/{resend-transport.ts,email.test.ts}`,
  `packages/core/src/schedules/{draft.ts,draft.test.ts}`, `packages/smoke/src/index.ts`,
  `.env.example`

### The picker was extracted before it was reused

`SchedulePicker` is now one component used by both "save a new search" and the new inline
edit form. Copying it would have satisfied every test while drifting — which is exactly
what happened with `describeCadence`, whose duplicate in `/alerts` labelled every hourly
schedule "Every day at 12:00 AM" for months without failing anything. The smoke check that
matched form field names to action reads was widened to cover both forms and now also
asserts there is still only one picker; it goes red on a second copy.

Both actions share one parser, `cadenceFieldsFrom`. Create and update differ in exactly one
place and it is commented: a patch uses `null` to mean "clear it", a create has nothing to
clear and the contract refuses a daily schedule carrying a weekday at all, so the field is
omitted rather than nulled. Switching weekly → daily has to clear the weekday or the row
carries two answers to "when does this fire".

Editing does **not** resume a paused schedule. Changing the time of something switched off
is not a request to switch it on, and the form says which it is.

### The interval label was wrong in a new way

Removing the one-week ceiling last session made `describeCadence` say **"Every 336 hours"**
for a fortnight — right, and not a sentence anybody would say, on a card somebody is asked
to agree to. It now uses the largest unit that divides cleanly: weeks, then days, then
hours, then minutes. One day stays "Every 24 hours" rather than "Every day", because
"Every day" is the `daily` cadence — a wall-clock time that survives a DST change — and an
interval is elapsed time that does not.

### `ALERT_EMAIL_FROM` is now checked, not just present

`.env.example` carries `alerts@quotemydecking.com.au` with a note. More usefully,
`requireSenderIdentity` now rejects a value that is not an address: the live config held
the bare domain `quotemydecking.com.au` for two days, which passed the non-empty check,
went out as `Test Company <quotemydecking.com.au>` and was refused by Resend on every
send. Recorded honestly on each run, which nobody reads until somebody asks why no email
arrived. Present is not the same as usable.

A shape check, not an RFC 5322 parser — the mistake to catch is a missing mailbox, and
anything stricter starts rejecting valid addresses to catch faults nobody has made. The
message carries the fix, not just the verdict, because it is read by whoever set the
variable and thought it was fine.

### Verified against the live database

    created  -> Every day at 8:00 PM, Sydney time
    retimed  -> Every day at 4:15 PM, Melbourne time
    weekly   -> Every Saturday at 9:00 AM, Melbourne time
    interval -> Every 2 weeks      | weekday cleared: true
    next run re-anchored to the future: true
    9-minute edit refused: The shortest gap we can run is every 10 minutes

Three guards broken on purpose and seen red (§ 12): the one-picker assertion (replaced the
shared picker with a raw select), the field-name match, and the address validation.

- Left unfinished (exact next step): the edit form was exercised through core rather than
  through a browser — the server action wire format defeated a curl reproduction, which is
  what the field-name smoke check exists to cover. Worth one manual pass on `/alerts`.
- Risks / watch: the sending domain still has to be verified in Resend before any real
  recipient can be reached, and the Spam Act footer is still `Test Company` /
  `123 Test St, Test City`.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **597** (414 `@repo/core`, 183 `@repo/ai`)
- `pnpm smoke` — **94 passed, 0 failed**, 10 skipped
- `/` still `○` static, 459 B · `/alerts` 3.67 kB · `/search` 3.99 kB

## 2026-09-28 — Claude Code — an exact clock, no ceiling, and three fixes

- Goal: the three faults reported last session, plus an alarm-style AM/PM time picker with
  a hard 10-minute floor and no upper limit.
- Files touched: `packages/core/src/schedules/{time-input.ts,sweep-runs.ts,claim.ts,run-schedule.ts,schedule-schema.ts,index.ts,draft.test.ts,time-input.test.ts}`,
  `packages/ai/src/tools/{schedule-tools.ts,index.ts,schedule-tools.test.ts}`,
  `apps/web/app/alerts/{page.tsx,actions.ts}`, `apps/web/components/save-search.tsx`,
  `packages/smoke/src/index.ts`

### 1. `/alerts` was lying about every interval schedule

It carried its own copy of `describeCadence` that knew `weekly` and read everything else
as daily. An interval row holds `sendAtMinute: 0` because an interval has no clock, so an
hourly schedule was labelled **"Every day at 12:00 AM"** — wrong about both halves, on
screen, for as long as the page has existed. The page imports core's formatter now. Two
formatters for one fact is how they drift, and nothing failed while they did.

### 2. The test suite was editing a real person's data

`claimDueSchedules` had no way to narrow, so the concurrency check claimed whatever
happened to be due — and it did, leaving **four half-finished runs on a live saved
search**. `claimDueSchedules` and `runScheduleTick` now take `ownerId`; the scheduler
never passes it and smoke always does. Written as a narrowing that composes into the same
WHERE, so it cannot widen anything and an omitted value behaves exactly as before. The
tick check now asserts `claimed === 1` rather than `>= 1`, so a leak fails.

### 3. The stuck rows had a cause, so the cause was fixed too

`sweepAbandonedRuns` closes out any run still `running` 30 minutes after it was claimed,
and the tick calls it beside the retention prune. This is not only a test artefact: the
claim commits before the work starts (§ 8 keeps network calls out of transactions), so a
crashed tick leaves exactly the same row and always could have. **Marked failed, not
deleted** — a lost alert must not be indistinguishable from one that never happened — and
`consecutiveFailures` is deliberately untouched, because the schedule did nothing wrong.
The four live rows were swept. Nothing was blocked by them: each run is keyed on its own
slot and the cursor had already moved, which is why nobody noticed.

### 4. The picker offered eight times, and the ceiling was wrong

The time control was a dropdown of eight times on the hour, 7 AM to 9 PM. It looked like a
design and was a limit: 4:15 PM was not a setting anybody could choose, and the column has
always been a minute of the day, so nothing below it was in the way. Now hour · minute ·
AM/PM, every minute of the day.

**Three selects, not `<input type="time">`.** That was the obvious choice and it is wrong
here: whether it renders 12-hour or 24-hour follows the *browser's* locale, not the page's,
so an AM/PM picker would silently become a 24-hour one for some visitors.

**Parsed on the server.** It would have been one line to multiply the three fields out in
the browser and post a hidden `sendAtMinute`, and then the number deciding when mail goes
out would be one the browser chose (§ 9). It also still works with JavaScript off.

**The field is `sendAtMinuteOfHour`.** It was briefly `sendAtMinute` — the same name as the
column, which is a minute of the *day*. One careless edit from 8:00 PM being stored as
12:20 AM.

**The ceiling is gone; the floor is absolute.** `MAX_INTERVAL_MINUTES` was one week, on the
reasoning that `weekly` was the better shape past that. It was wrong in an ordinary case:
`weekly` cannot express a fortnight, so "every two weeks" was silently clamped to one week
— twice the email somebody asked for. The only bound left is the `integer` column's
(~4000 years), which exists so the limit fails with a sentence rather than a stack trace.
The 10-minute floor stays hard and is enforced twice, differently on purpose: the form
**refuses** with the reason beside the field, the chat tool **clamps**, because a model
that has begun a sentence narrates a refusal as success and the visitor sees no card.

### Five new checks, each broken on purpose first (§ 12)

| Check | Broken by | Went red with |
|---|---|---|
| the alerts page does not hand-roll a cadence label | removing the import | "a second cadence formatter has come back" |
| a claimed-and-never-finished run gets closed out | dropping the sweeper's cutoff | "a run claimed seconds ago was swept — too eager" |
| the form and its action agree on every field name | renaming one `name=` | "the form sends sendAtMinuteOfHourX and the action never reads it" |
| no live run is stuck half-finished | — (invariant over real rows) | |
| an exact AM/PM time survives the round trip | — | 4:15 PM → 975; 9 minutes refused; a fortnight accepted |

The field-name check is the one that needed writing: the picker renders `name="…"`, the
action reads `formData.get('…')`, nothing connects them but a string, and a mismatch
compiles, throws nothing and fails no test.

`time-input.test.ts` covers the arithmetic — the 12 AM / 12 PM trap in both directions
(the naive `hour12 + 12` puts midnight at noon), a round trip over all 1440 minutes, and
`''` being rejected rather than read as `Number('') === 0`.

- Left unfinished (exact next step): there is still no way to **edit** an existing
  schedule's time — `/alerts` offers Turn on / View results / Delete, and `updateSchedule`
  already supports it. The chat's `draft_schedule` takes `atTime` as 24-hour text, so the
  model converts "4:15 PM" itself; that conversion is not tested against a live model.
- Risks / watch: `ALERT_EMAIL_FROM` is still `"quotemydecking.com.au"`, a bare domain
  rather than an address, so any real send will be rejected by Resend.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **584** (401 `@repo/core`, 183 `@repo/ai`)
- `pnpm smoke` — **94 passed, 0 failed**, 10 skipped
- `/` still `○` static, 457 B · `/search` 3.73 kB · `/alerts` 2.06 kB

## 2026-09-28 — Claude Code — an account section, and a way out of it

- Goal: somewhere to see the account and sign out of it. There was no sign-out control
  anywhere on the site; `/sign-out` existed and nothing pointed at it.
- Done: `/account` (name, email, member since, saved-search count, change password, Log
  out), an account chip in the shared header, and `/alerts` finally wrapped in the shell.
- Files touched: `apps/web/app/account/{page.tsx,account.module.css,loading.tsx}`,
  `packages/ui/src/app-shell.{tsx,module.css}`, `apps/web/components/web-shell.tsx`,
  `apps/web/app/{page,search/page,chat/page,listing/[id]/page,alerts/page,alerts/loading}.tsx`,
  `apps/web/app/alerts/alerts.module.css`, `packages/smoke/src/index.ts`

### The design constraint was `/`, and it shaped everything

`/` is the site's only statically rendered route (`revalidate = 300`, measured at 33 ms).
Drawing an account chip means knowing whether somebody is signed in, which means reading
a cookie, and a `cookies()` call anywhere in that tree opts the whole route out of static
rendering — silently, with no error.

So the chip is **data passed in**, not a session read: `AppShell` takes
`account?: { signedIn: boolean }` and packages/ui never learns what a session is. Every
`force-dynamic` page passes it; `/` passes nothing and its header is unchanged.

`undefined` and `{ signedIn: false }` are deliberately different. The first means "this
page did not look", the second means "nobody is signed in". Collapsing them would put a
Sign in button in front of somebody who already is.

Build output after: **`/` still `○` static, 457 B, revalidate 30s.** `/account` is 651 B.

### A menu would have cost more than it was worth

The header renders on every route, so a dropdown there is either client JavaScript in the
most widely rendered component on the site, or a `<details>` panel that cannot close on
an outside click without the same JavaScript. The chip is a link and the account page is
the panel — it holds what a menu never could, and Log out is a plain `<form method=post>`
that works with JavaScript off. /sign-out stays POST-only, for the reason already written
there: Next prefetches links in the viewport.

### No initial in the chip, on purpose

`/chat` and `/alerts` are inside the middleware matcher and know the visitor's name;
`/search` and `/listing/[id]` are outside it on purpose and only have a cookie sniff. An
initial would therefore be a letter on some pages and a shape on others, which reads as a
bug. The glyph is uniform; the name lives on `/account`.

### `/alerts` had no header at all

It rendered its own `<main>` instead of going through the shell — no brand, no nav, no way
back to the site but the browser's back button. That is also why the account control had
nowhere to sit. Now wrapped, with its own top padding dropped so it is not padded twice.

### The new guard caught its own author

`pnpm smoke` asserts that three files — `app/page.tsx`, `web-shell.tsx`, `app-shell.tsx` —
read no session. The first version searched the source for `cookies(` and went red on the
comment in `page.tsx` explaining the rule. Prose about a ban is not the ban being broken,
so it checks **import statements** instead, where a session read cannot hide. Broken
deliberately afterwards (§ 12) by importing `looksSignedIn` into `web-shell.tsx`:

    ✗ apps/web/components/web-shell.tsx imports looksSignedIn — reading a session
      there makes the statically rendered / dynamic

### Verified end to end, real cookie jar on the running dev server

Signed up through the real form → `/account` 200 with name, email and "September 2026" →
chip present on `/search`, `/chat`, `/alerts`, `/listing/[id]` and absent on `/` → signed
out shows "Sign in" → `POST /sign-out` 303 to `/`, after which `/account` is
`307 /login?next=%2Faccount`. `GET /sign-out` is 405. Probe account deleted afterwards.

- Left unfinished (exact next step): `/alerts` still labels an `interval` schedule as
  "Every day at 12:00 AM" — `cadenceLabel` in `alerts/page.tsx` has no interval branch and
  duplicates core's `describeCadence` instead of importing it. Reported, not fixed.
- Risks / watch: three `schedule_run` rows are stuck in `running` on a real schedule,
  left by smoke's claim test claiming a row it does not own.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — 564 (383 `@repo/core`, 181 `@repo/ai`)
- `pnpm smoke` — **89 passed, 0 failed**, 10 skipped
- `/` 457 B / 131 kB (static, 30s) · `/account` 651 B / 107 kB · `/alerts` 2.06 kB / 108 kB

## 2026-09-28 — Claude Code — the interval floor drops to 10 minutes

- Goal: let somebody schedule a search more often than hourly. Asked for 5, settled on 10.
- Done: `MIN_INTERVAL_MINUTES` 60 → 10; the Vercel tick `*/15` → `*/5`; `everyMinutes`
  added to `draft_schedule` beside `everyHours`; the clamp report rewritten from hours to
  minutes plus a ready-made phrase.
- Files touched: `packages/core/src/schedules/schedule-schema.ts`,
  `packages/ai/src/tools/schedule-tools.ts`, `packages/ai/src/tools/index.ts`,
  `packages/ai/src/tools/schedule-tools.test.ts`, `packages/smoke/src/index.ts`,
  `apps/web/vercel.json`, `apps/web/CRON.md`, `docs/STATUS.md`

### The floor and the tick are one number written twice

`nextRunFor` advances an interval schedule exactly one slot from the slot it just ran,
never to `now` — that is what keeps an 8 PM alert at 8 PM after an outage. A row
therefore catches up at one slot per tick, so **the tick has to be strictly faster than
the shortest interval or a schedule that falls behind never returns**. At the numbers
asked for — a 5-minute floor on a 5-minute tick — that is 1:1 and the backlog is
permanent. 10 against 5 is 2:1 and drains.

Nothing imports one of those numbers from the other and nothing would have failed if
they drifted; the schedules would simply have stopped catching up, silently, months
later. So `pnpm smoke` now reads `apps/web/vercel.json`, parses the cron and asserts the
ratio. Set back to `*/15` it reads:

    ✗ the cron tick is strictly faster than the shortest interval
      the tick is every 15 min and the shortest schedule is every 10 min

### Why the clamp report had to change units

The clamp already existed and was right: an out-of-range frequency produces a real card
at the nearest legal value rather than a refusal the model narrates as success. But it
reported `askedForHours` / `usingHours`, and at a 10-minute floor a clamped "every 5
minutes" becomes `usingHours: 0.1666…` — a fraction the model then has to turn back into
English in front of the visitor. It now carries minutes and a `using` string taken from
the same `describeCadence` that writes the card, so the two cannot disagree.

`everyMinutes` exists for the same reason at the input end: ten minutes as `everyHours`
is a fraction the model has to derive before it can be parsed.

### Cost, which was the actual worry and is not one

A run that finds nothing new returns before the model call and before the transport
([run-schedule.ts:177](packages/core/src/schedules/run-schedule.ts#L177)). So a
10-minute schedule is 144 runs a day of which almost all are one SQL query and a row —
not 144 emails, and not 144 Haiku calls. Email volume tracks new listings, not cadence.

- Left unfinished (exact next step): nothing ticks the cron on localhost, so the one live
  schedule has been due since 2026-09-26 and `pnpm smoke` fails its stale-cursor check
  because of it. That check is correct and should stay red until a tick runs.
- Risks / watch: `ALERT_EMAIL_FROM` is `"quotemydecking.com.au"` — a bare domain, not an
  address. `requireSenderIdentity` only checks it is non-empty, so this will reach Resend
  as `Test Company <quotemydecking.com.au>` and be rejected. Sender name and postal
  address are still the `Test Company` dummies.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10
- `pnpm test` — **564** (383 `@repo/core`, 181 `@repo/ai`)
- `pnpm smoke` — 86 passed, **1 failed** (the stale cursor above), 10 skipped

## 2026-09-26 — Cursor — chat history is a screen

- Goal: A proper history screen, and opening a past chat should show that conversation and leave it open.
- Done: `/chat?history=1` replaces the dropdown. Each row links to `/chat?thread=…`. `ChatView` is keyed on the thread id so client navigation actually loads the turns. The last search is restored into the sidebar. Saving a turn writes `?thread=` with `history.replaceState` so a reload reopens it without remounting mid-card. Delete returns to the history screen.
- Files touched: `apps/web/app/chat/page.tsx`, `chat-view.tsx`, `chat-toolbar.tsx`, `history-screen.tsx`, `chat.module.css`, `thread-actions.ts`, `docs/TEST-PLAN.md`
- Decisions: History is a query on `/chat`, not a new route. The URL update on save is `replaceState`, not `router.replace`, because a Next navigation would remount the keyed view and drop an unconfirmed schedule card.
- Left unfinished (exact next step): Signed-in open-a-thread was not clicked in the browser here — that browser had no session. Confirm on a signed-in account: History lists the chat, Open shows the turns, reload keeps them.
- Risks / watch: `useState` will ignore new turns again if the `key` on `ChatView` is removed.

## 2026-09-26 (and finally) — Three bugs behind one "i signed in already???"

The previous fix was right and did not fix it, because there were three
faults stacked and each one hid the next. Found by reproducing the whole
flow with a real cookie jar instead of reasoning about it.

### 1. `/api/chat` was outside the session layer

`/chat` was in the middleware matcher, `/api/chat` was not. The page knew
who you were; the route did not. Fixed, and guarded by a smoke check that
asserts the `x-web-session` marker on both the chat API and the cron API —
because a matcher line can be deleted and nothing else would notice.

### 2. The session cookie was being thrown away on `localhost`

`cookieOptions()` applied `COOKIE_DOMAIN=.lvh.me` unconditionally. RFC 6265
requires a cookie's `Domain` to domain-match the host, and `.lvh.me` does
not match `localhost` — so on `http://localhost:3000` **the browser
discarded every session cookie silently**. Sign-in appeared to work, the
redirect happened, and there was never a session. Nothing logs, because
rejecting a cookie is the browser's decision and the server never hears.

`cookieDomainFor(host)` now applies the domain only when the host belongs
to it. Verified both ways on a real signup through the real form:

    localhost      Set-Cookie: sb-…-auth-token=…; Path=/; SameSite=lax
    web.lvh.me     Set-Cookie: sb-…-auth-token=…; Path=/; Domain=.lvh.me

Host-only where it must be, shared where the console depends on it. It also
refuses a suffix that is not a subdomain — `evil-lvh.me` ends with `lvh.me`
as a string and is a different site.

### 3. The account had no `public.user` row

The one that actually ate the conversations. Everything a consumer owns has
a foreign key to `public.user`, and that row was only created on a visit to
`/alerts`. Somebody who signed up and went straight to the chat had a
session and no row, so every transcript insert died on
`chat_thread_user_id_user_id_fk` — and `persistTurn` swallows its errors by
design, so the symptom was an empty History with nothing to explain it.

    detail: 'Key (user_id)=(05f98b56-…) is not present in table "user".'

The row is now created in the sign-up and sign-in actions, from Supabase's
own response rather than the form (ADR 0006, on the one request where the
session headers do not exist yet because that request is creating them),
with `ensureConsumerAccount()` in the transcript writer as the belt.

**Two real accounts were already in that state** — `saad@gmail.com` and
`shahzaib13118@gmail.com` — and have been repaired, name included where
the signup metadata had one. Tightening the rule and repairing the rows in
the same change, per § 7.

`pnpm smoke` now asserts zero unmirrored accounts, as a data invariant
rather than a code review.

### What the whole flow does now, end to end and verified

Signed up through the real form on `localhost`, then:

- `/chat` and `/api/chat` both report `x-web-session: user`
- "schedule this every 10 minutes" → *"The shortest interval this site can
  run is every hour. I've set up a schedule … every hour instead. A
  confirmation card will appear"* — clamped, honest, card drawn
- the conversation saved: a `saved` frame with a thread id, a `chat_thread`
  titled from the first message, and both turns in `chat_message`
- no `membership` row, which is the point of ADR 0011

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **562** · `pnpm smoke` — **78 passed, 0 failed**

### The lesson worth keeping

Every one of these was invisible to the tests that existed. The database
probe called core functions directly and skipped the route; the unit tests
mocked the context; the smoke checks used a cookie-less client. All three
faults lived in the space between those. The check that would have caught
the first one — assert the marker, not the config — is the shape the other
two now have as well.

## 2026-09-26 (and then) — "i signed in already???"

Two bugs, both reported from one screenshot, and the first is the worst
one in this whole feature so far.

### The chat API was outside the session layer

`/chat` was in the middleware matcher. **`/api/chat` was not.**

So the page knew who you were and the route did not. A signed-in visitor
asking to schedule something was told to sign in — and `persistTurn` reads
the same header, so **every conversation silently failed to save**. Chat
history worked perfectly in the database probe and never once worked in the
browser, because the probe called the core functions directly.

The page being in the matcher is what hid it: the History sidebar was
populated from a Server Component that DID have a session, so the UI looked
signed in while the route it talked to did not.

`/api/chat` is now in the matcher. The round trip is affordable precisely
there — the route is already `force-dynamic` and already spends a second on
a model. `/api/cron/*` and `/api/revalidate` stay out: a machine caller has
no session and refreshing one for it is pure cost.

The smoke check asserts the `x-web-session` marker on both, rather than the
matcher's contents — a config line can be deleted and nothing else would
notice. Removing `/api/chat` from the matcher turns it red; verified.

### Typing re-rendered the map

Reported as the pins refreshing on every keystroke, and read as the page
reloading. It nearly was: `draft` was `useState` on `ChatView`, so every
character re-rendered the transcript, the sidebar, the results panel and
the Google map inside it — thirty times a sentence.

Two changes, both ordinary:

- **The draft moved into `Composer`**, its own memoised component. State
  belongs at the lowest node that needs it. Typing now re-renders a
  textarea and a send button; `ChatView` does not re-render at all. The
  parent hears about the draft once, on submit.
- **`ResultsPanel` is memoised.** Its props change when a search returns,
  which is rare; its parent re-renders on every streamed token. Without
  this the map was reconciled on each one, which is the flicker.

`memo` and the move are both needed — without `memo` the parent's own
re-renders during streaming would reconcile the textarea on every frame.

One consequence, taken deliberately: the delivered-run card's "Ask about
these" used to prefill the message box, and the parent can no longer write
into it. It sends the message instead, which is also the better behaviour —
the button says "Ask about these", and one click doing that beats one click
typing for you.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **557** · `pnpm smoke` — **77 passed, 0 failed**
- `/chat` 11.8 kB / 123 kB, unchanged by the split

## 2026-09-26 (and then) — Three bugs the screenshot found

A real conversation, screenshotted: *"can you schedule that after every 5
mins"*, and the guide answered **"Unfortunately, scheduling isn't
available at the moment."** Three separate faults behind that one reply.

### 1. Two reasons that read as one

`ToolContext.scheduling` was an optional object, and absent meant either
"not signed in" or "no signing secret configured". The tool could not tell
them apart, so somebody who simply had no account was told the feature was
unavailable — false, unactionable, and it reads as a broken product when
the fix takes ten seconds.

It is now a discriminated union: `ready | signed_out | unconfigured`. The
property is **required**, so every construction of a tool context has to
say which — the same forcing function `getModel`'s `never` guard has, and
it caught four call sites immediately.

The same distinction `packages/smoke` already draws between "you chose not
to spend money" and "you asked to and cannot".

### 2. The model narrated a card that did not exist

Signed in, asking for five minutes: the floor refused it, and the model
said *"A confirmation card should appear letting you accept the schedule to
email you every 5 minutes."* No card, no schedule, and a confident sentence
saying otherwise.

A sterner prompt rule would not fix that — the model had already begun its
sentence before the result came back. So the tool stopped refusing:
**out-of-range intervals are clamped into range and a real card is always
drawn.** Five minutes produces a card reading *Every hour*. The model
cannot claim a card that is not there, because there is one; and it cannot
misdescribe it, because the card is written by the server. The adjustment
is reported so the model can explain it, but the truth no longer depends on
the model choosing to say it.

### 3. `lastSearch` did not survive the turn

The worst of the three, and only visible live. `tools` is built per HTTP
request, so `lastSearch` starts empty on every turn. "Schedule that" on the
turn after a search therefore told `draft_schedule` nothing had been
searched — the model re-ran the search to satisfy it, then tried again, and
hit `MAX_TOOL_ROUNDS` mid-sentence with nothing on screen.

The brief is already round-tripped by the client on every request, because
the conversation is not stored. `slotsToQuery` turns it back into a query
and seeds `lastSearch` at the top of the turn; a real `search_listings`
call still overwrites it with what actually ran.

The trust question is answered in the comment rather than waved away: those
slots come from a browser, have been through `slotsSchema`, and are used
only to PROPOSE a schedule on a card the person confirms — after which
`createSchedule` re-parses the path with the same vocabulary `/search`
applies to any shared link. The trust level is that of a pasted URL, which
is the level `/search` already works at. It never answers a question about
listings; only a real tool result carries a price.

### Verified live, all three

- signed out → *"you'll need to sign in to your account — it's free and
  takes just a moment"*
- signed in, five minutes → card reads **Every hour**, and the model says
  *"The shortest gap this site can run is every hour, not every 5 minutes.
  A confirmation card has appeared on screen."*
- the two-turn flow (search, then "schedule that") now draws the card on
  the first attempt

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **557** · `pnpm smoke` — **76 passed, 0 failed**

## 2026-09-26 (and then this) — Password auth, and a sign-in screen that was broken

Reported from a screenshot, and the screenshot was right: the copy was
wrapping one word per line down the left of the page.

### Why the layout collapsed

`AppShell`'s `wide` main sets `display: flex; flex-direction: column`. The
sign-in screen was a Tailwind two-column grid inside it, and its `1fr`
tracks have a `min-width: auto` floor — so the left track collapsed to the
width of its longest word while the card took the rest. Nothing was
mis-typed; the grid was reshaped by a container it did not know about.

Rebuilt as **`(auth)/auth.module.css`**, one centred column, the same way
/chat and /search are styled. A module owns its own box. A form with three
fields never needed a second column of marketing beside it, and a layout
with nothing to balance is a layout with nothing to go wrong.

### Magic link → email, password and a name

Asked for directly, and right. The trade is worth writing down because it
went the other way a few hours ago: a link in an inbox has no credential to
leak and no reset flow to build, but it also means waiting for an email
every time you want to look at your own saved searches. For somebody
checking property daily that is the wrong side of it — and it is why the
console has always used passwords.

Four screens, sharing one module: `/signup` (name, email, password),
`/login`, `/forgot`, `/reset`. All four are **169 B** each: plain forms
posting to server actions, no `'use client'` anywhere, working with
JavaScript off. Supabase's SSR client sets its cookies on the response, so
signing in server-side needs nothing in the browser.

### Two things about what is said back

**Sign-in gives one answer for a wrong password and an unknown address.**
Different messages there let anybody check which addresses have accounts.
Signup cannot hide it — the account is either created or it is not — so
that one says so plainly rather than stranding somebody who already has an
account, and the enumeration is closed where it can be.

**Forgot-password always says "check your email"**, whatever Supabase
returns, for the same reason.

### A build error worth remembering

`Failed to collect configuration for /reset`, naming neither a file nor a
reason. The cause was `export { MIN_PASSWORD }` from a `'use server'`
module — a server action file may only export async functions. The
constant now lives in `(auth)/constants.ts` with a comment saying why.

### Verified against the live project

Not guessed from the docs — run against this Supabase project:

- `signUp` succeeds and creates the user
- **"Confirm email" is OFF**, so a session comes back immediately and
  signup signs you straight in. The confirm-email branch is still written,
  because that setting is one checkbox away and the code branches on what
  came back rather than on an assumption
- `signInWithPassword` works
- a wrong password returns exactly `Invalid login credentials`, which is
  what the error mapping keys on

Probe accounts deleted afterwards.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **554** · `pnpm smoke` — **76 passed, 0 failed**
- A new smoke check renders all four screens and asserts the fields each
  one claims — which is also what would catch somebody reaching for
  `createBrowserSupabaseClient` again and putting 69 kB back on the route
- `/login` `/signup` `/forgot` `/reset` — 169 B / 106 kB each

## 2026-09-26 (last) — A door to the history, and a real sign-in screen

Both reported from a screenshot, and both the same kind of mistake: the
thing existed, the way in did not.

### The history had no door

`ThreadList` lived in the chat sidebar, and the sidebar renders only once a
conversation has started (`{!empty ? sidebar : null}`). So a returning
visitor landed on the empty hero with no route back to anything they had
said. The list was correct, queried correctly, and unreachable.

It is now a toolbar above the conversation — **New chat** and **History** —
rendered in both states. History is a dropdown rather than a column,
because the hero is a centred page with no room for one and a list of past
conversations is something you open rather than read while typing. Signed
out it says the chats are not being saved and offers a sign-in, which is
the truth; an empty list would have read as "you have none".

### There was no way to sign in at all

The header had Search and Ask the guide, and nothing else. Accounts,
alerts and saved conversations all existed with no link anywhere in the UI.

The header now carries **My alerts**. One neutral link for both states, on
purpose: telling signed-in from signed-out here would mean reading the
session cookie in the shared header, and that header renders on `/`, which
is a statically rendered ISR route measured at 33 ms. A `cookies()` call
there would make it dynamic. So the link names its destination and the
routing sorts it out — middleware sends a signed-out visitor from /alerts
to /login?next=/alerts and back again afterwards.

### The sign-in screen

Was a plain card. It is now a two-column page in the site's own type —
Fraunces display, warm cream, deep green — with the reason to bother on the
left and the form on the right. Everything in that column is something the
account actually does; a bare email box on an empty page asks somebody to
hand over their address for no stated return.

Four states, all server-rendered: idle, sent, expired-link, bad address.
Still **352 B / 107 kB** — no `'use client'` anywhere on the route, and it
works with JavaScript off.

### Verified

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **554** · `pnpm smoke` — **75 passed, 0 failed**
- Two new smoke checks, both guarding exactly the reported bugs: the chat
  renders New chat and History *before a word is typed*, and `/`, `/search`
  and `/chat` all carry an account link. `/` still returns no
  `x-web-session` header, so it is still outside the session layer.
- Every Tailwind token used by the new screen was checked against the
  compiled CSS rather than assumed — `bg-canvas`, `font-display`,
  `bg-notice-soft`, the arbitrary shadow and the rest all emit.

## 2026-09-26 (later) — Scheduling becomes something you ask for

The sidebar button is gone. Scheduling is now two tools the guide reaches
for when the visitor asks, and a confirmation card they press Accept on.

### Why the button was wrong

It offered one frequency, in one place, with no way to say anything else
about it. "Send me this every two hours" had nowhere to go. A tool can take
any of them, show what it understood, and be argued with.

### The frequency model grew a third shape

`daily` and `weekly` are statements about a **wall clock** and are resolved
against a timezone — that is the whole reason `next-run.ts` exists. "Every
two hours" is a statement about **elapsed time** and has no opinion about
what the clock reads. Trying to express one as the other is how a scheduler
fires twice at 2 AM once a year, so `interval` is its own cadence with its
own column and its own branch, and the branch does no timezone work at all.

Floored at an hour: the tick runs every fifteen minutes, so anything finer
is a promise the scheduler cannot keep, and "every five minutes" describes
a notification product rather than a digest.

### Nothing is written until Accept

`draft_schedule` writes nothing. It returns an **HMAC-signed draft** and the
pipeline yields it as a `schedule_draft` frame, which the chat renders as a
card. Pressing Accept sends the token back; `acceptScheduleDraft` verifies
it and only then creates the row.

Signed rather than stored as a `draft` row, for two reasons: nothing exists
until somebody agrees, which is what was asked for, and a card nobody
accepts leaves nothing to collect. The signature is what makes it safe — a
browser can read the draft and cannot change the search or the frequency
inside it.

**The token carries no user id.** It authorises the content; the session
decides whose it becomes. That is what lets an anonymous visitor be shown a
card, sign in, and accept it as themselves.

The card's wording is the SERVER's, derived from the draft that will
actually be stored — not the model's account of what it did. What somebody
presses Accept on has to describe the row.

### Cancel pauses, and that is why it needs no card

`cancel_schedule` pauses rather than deletes. Reversible in one click from
/alerts, so a model that misreads "cancel the Pakenham one" costs a resume
rather than somebody's saved search — which is the whole reason creating
needs confirmation and stopping does not. Ambiguity stops it: two matches
returns the names and asks, because pausing the wrong alert is silent and
only noticed when the email stops.

### What the live model actually did

Two rounds against the real model, and the first found a prompt bug.

**Cancel worked first time**: called the tool, said "paused", pointed at the
alerts page.

**Drafting did not.** The prompt said "a search must have run", the model
read it as "there must be results", and refused to schedule an empty
Pakenham rental search — *"I need at least one result to work with"*. That
is backwards. An empty search is when an alert is most useful: "there is
nothing right now" is exactly when somebody wants to be told the moment
there is. The prompt (v8) now says so in as many words.

After the fix, both paths work: "every 2 hours" over a populated search
drafts `Every 2 hours` with a verifying token, and "email me daily when
something comes up" over an empty one drafts `Every day at 8:00 PM, Sydney
time`.

One residue, honestly: the model sometimes writes "Done." before "A
confirmation card is now on screen", which the prompt explicitly forbids.
The card itself says *Nothing is saved until you accept*, and that is the
surface somebody acts on, so this is a wording annoyance rather than a
false claim about state. Not chased further.

### Verified

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **554** (378 `@repo/core`, 176 `@repo/ai`)
- `pnpm smoke` — **73 passed, 0 failed**, including an every-2-hours cursor
  that advances by exactly 120 minutes and a signed draft whose frequency
  cannot be swapped
- `/chat` 11.3 kB / 123 kB

## 2026-09-26 — The AI task scheduler

A saved search that runs itself: prompt and time in, email and an in-app
record out. Nine pieces, and only one of them is the scheduler.

### The decision everything follows from

**A schedule stores a frozen query, not a prompt to re-interpret** (ADR
0010). The obvious reading of "the AI runs the research daily" is that
`runPropertyChat` runs again each morning. That is wrong here for three
reasons, in ascending order of cost: a scheduled search must be the search
that was confirmed, and a model re-reading the sentence can drift without
telling anyone; every existing cost ceiling is an in-process `Map` keyed on
an IP and a cron tick has neither; and under the ACL "what did we send this
person and why" has to be answerable from the database.

So the run path is pure SQL, and the browser hands over the **`/search?…`
path** rather than a set of filters. The server re-parses it with the same
vocabulary `/search` itself parses — which meant giving
`packages/core/src/listings/search-url.ts` an inverse it never had. That
file's own header note had been asking for it: three places wrote the URL
vocabulary and nothing read it back.

### Consumer accounts, and the matcher that is the whole point

`apps/web` had no auth at all. It now has magic-link sign-in and no
passwords — the address *is* the product here, so proving it works is the
only signup step worth having, and it deletes the reset flow entirely.

**The matcher is the load-bearing line.** `updateSession` is a Supabase
round trip, and `/`, `/search` and `/listing/[id]` are the three fastest
pages in the repo, measured with no middleware. They stay outside it. `/`
is still `○` static with ISR 30s after the change.

`/login` first shipped at **69.2 kB / 176 kB** — supabase-js in the browser
to send one email. Moving the OTP send into a server action made it **161 B
/ 106 kB**, and it works with JavaScript off.

A consumer is an `Actor` with a userId and **no agency** (ADR 0011). The
tempting alternative — a `membership` row with a `consumer` role — needs a
sentinel agency, and `public.user_agency_ids()` would then hand every
consumer SELECT on eleven tables of other people's data. `Actor` needed no
change; `Resource` gained `ownerId`.

### Three things found by running it, not by building it

- **`POST /sign-out` redirected to `localhost`.** `request.url` is the
  address the server listens on, not the host the browser asked for. That
  drops the `.lvh.me` cookie scope, so a signed-out visitor can land looking
  signed in. The same trap `@repo/auth/callback` documents.
- **My own smoke check was worthless until I broke it.** "The public pages
  still have no session layer" tested only that `/` does not redirect — and
  stayed green with the matcher widened to *every route on the site*,
  because a widened matcher does not redirect, it just spends a round trip.
  Absence of a redirect was never the invariant. The middleware now sets an
  `x-web-session` marker and the check asserts its absence on the public
  pages *and* its presence on `/login`, so "absent" means "did not run"
  rather than "no such header".
- **The comment on the claim was wrong, and measuring said so.** It claimed
  `FOR UPDATE SKIP LOCKED` is what stops a double-send. Removing `SKIP
  LOCKED` left the check green; removing `FOR UPDATE` entirely left it green
  too; dropping the unique index on `(schedule_id, scheduled_for)` turned it
  red at once. The **index** is the correctness guard — the slot is the thing
  made exclusive, not the row. `SKIP LOCKED` earns its place for throughput:
  without it the second tick blocks behind the first rather than taking the
  next batch. Both kept, comment corrected to say which does what.

### #4 held structurally, in four layers

The one metered call per run writes two sentences of prose. It cannot
produce a number because: the facts carry no bare figures (prices arrive as
strings from `priceLabel`, counts as the words "a single"/"several"); the
request has **no `tools` key at all**, not an empty array; every figure in
the email is rendered by the template from SQL; and `findFigures` rejects
any output containing a digit, a `$`, a percentage or a written-out count.

Measured against the live model on real listings: **two of three accepted,
one rejected for the word "two"**. Rule 1 of the prompt now names
written-out numbers explicitly because of that run. A rejection costs
$0.0006 and a plainer sentence, not somebody's alert.

### #7 needed amending rather than dodging

The summary is model output reaching a person with nobody in between, which
#7 forbids. The rule as written says *listing* copy — an advertisement in an
agency's name under the ACL — so the scope is now written down: anything
model-written reaching a **third party** needs a human; anything reaching
the person who asked for it needs a **label**. The paragraph carries
"Written by the property guide" in the email and on `/alerts`.

### Spam Act, structurally

`buildScheduleDigestEmail` **throws** without a sender name, a postal
address or an unsubscribe URL. An email that cannot identify its sender is
not a degraded email; it is one that must not be sent, so the failure is a
throw rather than a line on a review checklist. Both parts carry the footer,
and `List-Unsubscribe` + `List-Unsubscribe-Post` are on every message.

The unsubscribe is a signed HMAC over the ids, with **no expiry on purpose**
— the Act wants the facility working for at least 30 days and people
unsubscribe from mail they find months later. `GET` performs it, which is
normally wrong: a confirm-first page is not compliant, so the resolution is
that the confirmation page's first control is a one-click undo.

### Verified

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **499** (352 `@repo/core`, 147 `@repo/ai`), was 406
- `pnpm smoke` — **70 passed, 0 failed**, two new groups, both free
- Live end to end: `claimed 1, delivered 1`, two listings snapshotted, the
  email refused by Resend with `403 validation_error` (the testing sender can
  only reach the account owner) and that refusal **recorded** on the run
  rather than swallowed — `status` stayed `delivered`, because the in-app
  channel succeeded and one channel failing is not the run failing
- `ai_run` row written with `cost_usd 0.000579` and a non-null `user_id`:
  the priced-alias guard holds and the budget has something to read
- Web routes: `/` 459 B / 131 kB (ISR 30s) · `/login` 161 B / 106 kB ·
  `/alerts` 1.44 kB / 108 kB · `/search` 3.78 kB / 134 kB (+2 kB for the save
  control) · `/chat` 9.89 kB / 121 kB (+0.68 kB for the delivered card)

### Two gaps the user found, and both are now closed

**There was no way to schedule from the chat.** The save control only
existed on `/search`, which is the wrong place: the chat is where people
describe what they want. The "Your search" panel now carries **"Email me
these daily"**, wired to the `/search?…` link the chat has always produced
per turn and never had a use for beyond opening it. It sends the sentence
too, which the `/search` path cannot — there somebody picked filters, here
they said something, and the sentence becomes the schedule's name.

Adding it cost `/chat` 17 kB of First Load, because `AU_TIMEZONES` lived
beside its `z.enum` and a `<select>` dragged zod and the whole saved-query
schema graph into the browser. The list moved to `schedules/timezones.ts`,
a module with no imports at all: **138 kB → 123 kB**. Same lesson as
SORT_OPTIONS one layer up — a vocabulary should cost what a vocabulary
costs.

**Chat history.** Originally left out; reversed on request.
`chat_thread` + `chat_message`, a sidebar of past conversations, and a
reopened thread that keeps its place.

The objection that made me leave it out turned out to have a clean answer:
**store only what `chatRequestSchema` already lets a client send.** A
stored assistant turn holds `text` and `searches` citations; the listings
live in a separate `results_frame` column that is display-only and that
`toModelTurns` drops on the floor. So replaying a stored thread is
byte-for-byte what the browser already posts today, `chatRequestSchema`
validates it unchanged, and no new trust surface opens. A tool result
remains the only source of a price (#4). `toModelTurns` is a pure function
precisely so that property has an offline test — break it to include
`resultsFrame` and two tests go red.

Neither table has an INSERT or UPDATE policy. A transcript line is written
by the server after it has run the turn; an assistant turn somebody
authored themselves is the one thing that could put a price into the record
with no tool result behind it.

**Retention is enforced, not documented.** 90 days (APP 11.2), swept by the
scheduler tick — which already runs on a clock — before the budget check,
because deleting old data is free and must not be skipped when the model
budget happens to be spent. A person can delete a thread sooner; deleting
an account takes everything by cascade. `pnpm smoke` asserts no stored
conversation is older than the window, so a tick that stops is visible.

An anonymous visitor's conversation is still not stored at all, and the
sidebar renders nothing rather than an advert to sign in.

### Deliberately not built

- **No cross-device chat sync beyond the account**, and no export.
- **No catch-up.** A schedule paused for a month fires once on resume and
  re-anchors, rather than replaying every missed day.
- **`MAX_SCHEDULES_PER_USER` is not airtight.** Two requests in the same
  millisecond can both read nine. It is a ceiling on accident, and a unique
  constraint cannot express "at most ten rows".

## 2026-09-25 (and finally) — The onboarding wizard uploads the headshot

The field said it itself:

    Photo URL optional for now (R2 upload lands with media milestone).

The media milestone landed earlier today — on Supabase Storage, ADR 0009 — and
this was the one place still asking for a link.

### Uploading for somebody who does not exist yet

The wizard's draft lives in the browser until the invite is dispatched. There
is no user id and no `agent_profile` row, so there is nothing to key a storage
path on — which is the whole reason this was left as a URL box.

The stable id at that moment is the **agency**, from the session. So a third
owner kind: `agencies/<agencyId>/<uuid>.<ext>`, authorised by `team:manage` —
the same permission that lets someone run the wizard at all.

Deliberately **not** `assertCanEditAgentPhoto`. There is no agent to check
against, and inventing a placeholder id to satisfy that function would be a
check that looks like one and is not.

It is also the honest owner. The agency uploaded the file before anyone had
accepted anything, and if the invite is never taken up the file was always
theirs.

### The key travels

`inviteAgent` already creates `user`, `membership` and `agent_profile` in one
transaction at dispatch — the profile row exists the moment the invite is sent,
not when it is accepted. So the draft carries `photoKey`, validated by
`storageKeySchema` rather than as free text (it has been to a browser and back,
and a path is exactly the thing not to trust inbound), and the profile insert
writes it.

A later upload from the team drawer replaces it with an `agents/<userId>/…`
key and deletes the old object, so `keyBelongsTo` stays strict on that path.
Readers never validate — they only turn a key into a URL — so an `agencies/…`
key renders exactly like an agent-scoped one.

One line fixed while passing: `list-agents.ts` hard-coded `photoKey: null` for
a pending invite with no profile row, with a comment saying there was nothing
to upload against. Written one commit earlier, when that was true. The draft
carries the key now.

### Verified

Sign → PUT → public read against the live bucket, with a real agency id:

    key: agencies/5660ac6f-…/69227091-….png | schema ok: true
    PUT: 200
    public read: 200 image/png

And the folder separation is tested: collapsing `agency` into the `agents`
folder — which would let a wizard upload satisfy an agent-scoped check — turns
two tests red.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **406** (272 `@repo/core`, 134 `@repo/ai`)
- `pnpm smoke` — 64 passed, 0 failed

### Known cost

A wizard someone abandons leaves its upload behind. Nothing points at the file
and it is invisible, but it is paid for. Collecting orphans is a job for later
— not a reason to make the upload wait for a row that does not exist yet.

The URL box stays beside the uploader. An agency that already hosts its
headshots should not have to re-upload them, and `photo_url` is the column that
has always held those. The uploaded key wins wherever both exist, which is the
rule the public agent panel and the team directory already follow.

## 2026-09-25 (last, and then this) — "+ Add Agent" did nothing, and the reason was three rows down

Reported as a dead button on the agency team page. It is not a dead button.

    <Link href="/team/onboarding" className={styles.btnPrimary}>

A real link, to a route that exists and compiles — verified by running a
throwaway console on another port and watching it build:
`✓ Compiled /team/onboarding in 2.7s`.

### What the screenshot gave away

Safari's status bar, bottom-left:

    Open "agency.lvh.me:3001/team?agent=695676b2-…" in a new tab

That is the **roster row's** URL, and the cursor was at the top of the page,
nowhere near the row. Something belonging to a table row was lying across the
whole page — and the only thing on that page that stretches is:

    .row      { position: relative }        /* on a <tr> */
    .rowLink::after { position: absolute; inset: 0 }

The stretched-link pattern: the anchor sits on the agent's name, the overlay
makes the row clickable, one accessible name, no JavaScript. It is a good
pattern and it was applied to the one element it cannot be applied to.

**A `<tr>` does not reliably establish a containing block.** In Chrome it does,
which is why every screenshot before this one came from Chrome and nobody saw
it. In Safari the overlay resolved against the next positioned ancestor
instead, escaped the row, and covered everything above it — including the
button that "did nothing", which was simply underneath a transparent link to
somebody's agent profile.

### The fix is which element, not which property

`position: relative` moved off the `<tr>` and onto `.person`, the plain flex
div already wrapping the avatar and name inside the cell. A div is a containing
block in every browser, so the overlay cannot escape it anywhere.

The cost is honest and stated in the CSS: the clickable area is now the
avatar-plus-name block rather than the entire row. `cursor: pointer` moved with
it — a row that says "click me" across its full width and only responds in one
place is worse than one that says nothing. The hover tint stays, because that
only claims "this is the row you are over".

Two other `::after` overlays in the console were checked. Both sit on a card
and on a switch; neither is a table element.

`.person` was briefly declared twice in one file — the flex rules in one place
and the positioning in another. Folded into one. Two declarations of one class
where the loser is invisible is the trap `tailwind.css` already names about
`--color-surface`.

### What I could not do

**I did not reproduce this in Safari.** There is no Safari automation in this
repo, and the console needs a real session to render. The diagnosis rests on
four things that fit together and nothing that contradicts them: the link and
its route are real and compile; the only stretching rule on the page is that
overlay; its containing block was a `<tr>`; and Safari reported the row's URL
from a point three hundred pixels above the row.

Strong, but inferred. It wants one click in Safari to confirm.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — 404, unchanged; this is a CSS containing block and no unit test
  reaches it. The guard is the note in the stylesheet, which says what the
  rule is and which element it must never move back to.

## 2026-09-25 (last, later still) — The chat renders the Markdown it was already being sent

Reported from a screenshot: literal asterisks on screen.

    I'd start by looking at the suburbs nearest to Berwick: **Pakenham** and
    **Narre Warren South**.

The guide has always written Markdown — bold suburb names, numbered questions,
blank-line paragraphs — and `chat-view.tsx` put `turn.text` into a single
`<p>`. So every marker the model emitted was shown to the visitor.

The prompt was not the place to fix it. Bold place names and a numbered pair of
questions genuinely read better; telling the model to stop would have made the
answers worse to look at, not better.

### A parser for the subset a chat answer actually contains

`packages/core/src/markdown.ts` — bold, italic, inline code, ordered and
unordered lists, headings, paragraphs. Everything else passes through as text.

react-markdown plus remark is tens of kilobytes on a route already carrying the
chat client, and it parses tables, footnotes, reference links and HTML
passthrough that this text never contains.

In core rather than in the component for the reason `pageWindow` went there
earlier today: apps/web has no test runner, and a hand-written parser is
exactly the thing that needs its edges pinned. Fourteen tests.

**It returns a tree, not a string.** There is no `dangerouslySetInnerHTML` on
this path. The renderer turns nodes into React elements and React escapes every
string it is handed, so model output shaped by whatever an anonymous visitor
typed cannot become markup — by construction, not by sanitising.

**An unmatched marker stays literal.** `**not closed` renders as `**not
closed`. A parser that guesses where emphasis was meant to end eats characters
the visitor never sees again, and this also makes streaming safe: a half-
written `**bold` is just characters until the rest arrives.

### The other half of the bug

The same screenshots had this, from an earlier turn:

    …within 30 km of Pakenham.Within 30 km of Pakenham there are 3 homes…

A turn that searches writes prose, calls a tool, writes more — and the client
appends every delta to one string with nothing between the rounds. The pipeline
now emits a blank line on the first delta of a later round, lazily, so a round
that produces only a tool call leaves no trailing gap. Confirmed against the
live API:

    "…within a reasonable commute of home.\n\nWithin 20 km of Berwick…"

### A comment that was confidently wrong

The regex carried: *"`**` has to be tried before `*` or every bold marker reads
as two empty italics."*

It does not. Flipping the alternation and running the suite: **14 passed**. What
actually prevents it is `[^*]` inside each alternative — after the first `*`
comes another `*`, so the italic branch cannot start there and the engine falls
through to bold. The ordering is decoration.

Found by trying to prove the tests caught a real break and discovering the
break was not one. The comment and the test name now say the true thing, and
breaking bold handling for real turns four tests red.

That is worth recording on its own: a plausible explanation written beside
working code is not evidence. This one had survived being typed, read and
committed.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **404** (270 `@repo/core`, 134 `@repo/ai`)
- `pnpm smoke` — 63 passed, 0 failed
- `/chat` 9.21 kB / 121 kB — +0.6 kB, all of it the renderer. A Markdown
  library would have been thirty times that.

### Verified, and what was not

The parser is covered by unit tests that go red on a real break; the round
separator is covered by two, and was confirmed against a live turn; the new CSS
classes were confirmed in the stylesheet the page actually serves.

**Not** verified: a pixel screenshot of a rendered turn. Driving the chat UI
headlessly needs a browser automation dependency this repo does not have, so
the rendering itself was proved component-by-component rather than end to end.

## 2026-09-25 (last, later) — The guide can answer "where is the cheapest place near my office"

Two asks, and they turned out to be different sizes.

### 1. Ask for buy-or-rent when you are stopping anyway

v6 deliberately does **not** ask the channel. "I need a house in Pakenham" is a
complete brief to any human agent, and v1 blocking on "buy or rent?" before
showing anything was the bug v2 fixed. That is still right and v7 keeps it.

But the assumption also fired on a bare **"I need a house"** — no place,
nothing searchable, the guide stops to ask regardless. Assuming the channel
there buys nothing and spends the one question it was already going to ask.

v7 turns the rule on whether a search is *possible* rather than on the words:
no place → ask for the area and the channel together, one short message, then
search. Budget and bedrooms still wait until something is on screen; a first
message that asks four things is the interrogation v2 removed.

### 2. "Cheapest near my office" was unanswerable

`search_listings` sorts by price **or** by distance, never both, and the model
may not do the arithmetic itself (#4). So the guide could show the cheapest
anywhere in one suburb, or the nearest at any price, and then hand-wave the
trade-off in prose.

`nearbyMarket` answers it in **one statement** — a CTE, then two aggregates:

    listings  the cheapest inside the radius, each with its own distance
    bySuburb  per suburb: how many, the cheapest, how far the nearest one is

The second is what actually answers "where". Somebody asking wants a direction
to look in, not a single address. The prompt says to lead with it.

Three decisions worth keeping:

- **Straight-line, and the payload says so.** `distanceIs: 'straight-line
  distance, not drive time'`, and the prompt forbids turning kilometres into
  minutes. A routing API would be a per-listing network call and a bill; it was
  offered and declined. A road can double a crow-flies distance, so "about 12
  minutes" is an invented figure.
- **Unpriced listings are counted, not dropped.** "Contact agent" cannot be
  ranked as cheapest. Excluding them silently would shrink the market without
  saying so, so they come back as `unpriced` and the guide is told to mention
  them.
- **Sale ranks on `price_from`, rent on `rent_pw`.** A weekly rent and a sale
  price must never be sorted in the same column.

### Two things I got wrong on the way

**The read went straight to `ctx.db`.** Every other read on this route is
*injected* so apps/web can wrap it in `unstable_cache` — the context file says
so at the top — and mine was the only one hitting the database region on every
turn. Now injected, cached 30 s to match `cachedSearch`: the guide and the
results panel beside it must not disagree about how stale they may be.

**`query-count.test.ts` could not see it.** The counting fake had no
`execute`, so a hand-written SQL statement was invisible to every count in the
file. One line, and it is the kind of gap that makes a whole test file quietly
narrower than it reads.

### Verified live, and broken live

`pnpm smoke:ai` — the guide answered and named **Pakenham**, which is what SQL
says is cheapest nearby:

    Pakenham is your cheapest option near your office — one house at $23,000,
    about 10.3 km out (straight-line distance, not drive time).

Leads with the suburb, quotes the figure, does not invent minutes.

Then the check was broken to prove it is live: flipping `order by min(price)`
to `desc` makes SQL disagree with the answer, and it goes red naming both.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **388** (256 `@repo/core`, 132 `@repo/ai`)
- `pnpm smoke` — 63 passed · `pnpm smoke:ai` — **71 passed, 0 failed**
- Adding a tool moves `PROPERTY_CHAT_TOOLS`, which is the head of the cache
  prefix, so this resets the prompt cache **once**, deliberately.

### A flake, named rather than hidden

`a distance in the message becomes a radius, unasked` failed **once in five**
live runs. Not a regression — it passed on the two runs that already had the
new tool and v7 in place. The guide narrated its plan and stopped mid-word:

    "First, let me resolve that location, then search.Now "

`models.ts` predicted this in writing when the route moved to Haiku for cost:
*"A smaller model with no reasoning budget is more likely to make those
mistakes, not less."* Haiku accepts neither `effort` nor adaptive thinking, and
this turn now has four tools to choose between rather than three. If it gets
worse, the fix is a measurement against a model that takes an effort
parameter — not a prompt tweak.

## 2026-09-25 (last) — The chat broke again, on the same class of bug as last time

Reported as a screenshot: "Something went wrong reaching the assistant", after
several turns that had worked. The dev log had it exactly:

    [ai] property chat failed 400 {"type":"invalid_request_error",
      "message":"role 'system' is not supported on this model"}

`reconstructMessages` appended `{ role: 'system', content: '<known_requirements>…' }`
to the `messages` array. That is a **real** API feature — a mid-conversation
operator instruction that carries operator authority and sits after every cache
breakpoint, so it costs nothing in cache terms — and the code's comment about
why it was preferable to prepending text to the visitor's message is still
correct. It is also **implemented on the Opus and Fable families only**.

This route runs **Haiku 4.5**, which does not have it.

### Why it looked intermittent

The block only ran once `slots` had something in it. So the opening turns of
every conversation worked, and the moment the guide had actually gathered a
requirement — which is the point of the thing — every subsequent turn 400ed.
The screenshot shows precisely that: the sidebar full of gathered requirements,
and the next message failing.

### The same lesson, a second time

The commit two before this one is literally titled *"A model parameter is a
capability, not a preference — /chat was broken"*. It added `CAPABILITIES` to
`models.ts` for `effort` and `adaptiveThinking`, both of which Haiku rejects
with a 400, with a comment explaining that there is no degraded mode.

`midConversationSystem` is the third member of that set and was never added.
It is now, and the table is the point: **the three do not travel together** —
Sonnet 5 takes `effort` and adaptive thinking but *not* a system role in
messages. A tier would have got that wrong.

### The requirements still have to arrive

"It no longer 400s" is satisfied by dropping the requirements on the floor, so
the fix has two halves and both are asserted:

- **Model has the capability** → `{ role: 'system' }` after the final user
  message. Never `messages[0]`, always after a user turn, and either last or
  followed by the assistant turn the tool loop appends — all three are rejected
  by the API rather than ignored.
- **Model does not** → a third block on the top-level `system` array, *after*
  the two cached ones and deliberately **without** `cache_control`. Caching is a
  prefix match, so a block past the last breakpoint changes every turn without
  invalidating anything in front of it; the frozen prompt and the catalogue
  still come from cache. Adding a breakpoint there would rewrite the prefix
  every turn and cache nothing.

The fallback loses one property: the requirements are read before the
conversation rather than after it. That is the cost of a model that cannot take
the better carrier, and it is smaller than a 400.

`reconstructMessages` now takes the capability and **defaults it to false**.
A caller that forgets to ask gets the carrier every model accepts.

### Tests, broken first

Seven new ones. Verified by reintroducing each half of the bug separately:

- push the system message unconditionally → 3 red, including
  *"never puts a system role in messages on Haiku"*
- gate it correctly but drop the fallback → 2 red, including
  *"still sends the requirements on Haiku, as a trailing system block"*

One pre-existing test had to change: it asserted the old unconditional
behaviour. It now passes the capability explicitly, and a sibling covers the
default.

One of my own new tests was wrong and the failure taught me something: I
asserted the system message must be **last** in `messages`. It was at index 1
of 3. The fake client records the params object **by reference**, and the tool
loop keeps appending to that same array — so by assertion time the assistant
turn was already on the end. That is the second of the two legal placements,
and the request was valid. The test now asserts the actual rule.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **370** (255 `@repo/core`, 115 `@repo/ai`)
- `pnpm smoke` — **63 passed, 0 failed**
- `pnpm smoke:ai` — **70 passed, 0 failed** (one new live check, verified red)

### The live suite was green throughout the outage

`pnpm smoke:ai` was run on request. First result: **69 passed, 0 failed** — and
it proved nothing, because **not one live AI check sent `slots`**. Every one of
them took the empty-requirements path, which is the path that worked the whole
time the chat was broken. The entire AI group was green while the feature was
unusable for anyone who had got as far as telling the guide what they wanted.

That is the fourth check in this session to report green over the thing it
existed to cover, and the same shape every time: it asked a question the broken
system could still answer.

So: **a turn that already has requirements is not a 400** — a second message
with a brief already gathered, which is the state the visitor was in when they
hit it. It asserts the turn comes back *and* that the brief was not thrown away
on the way.

Broken against the live API to prove it works: reinstating the unconditional
push reproduces the visitor's own error verbatim —

    ✗ a turn that already has requirements is not a 400
      the guide errored: Something went wrong reaching the assistant.

Restored: **70 passed, 0 failed**.

### One row still unmeasured

`CAPABILITIES` says Opus 5 accepts the message carrier. That row is documented
rather than measured; the other two rows in that table were measured with one
1-token request each. It is off the default path, so nothing in production
depends on it being right — but it is not proven.

## 2026-09-25 (later again) — The filters offer what is listed, not what was typed

Reported as "filters ko dynamic karo". Checked against the database first, and
the report was an understatement. Four of the six controls on `/search` could
only ever empty the page:

    sale prices    ladder started at $750,000   dearest live listing: $50,000
    beds           offered 1–5                  most any property has: 3
    baths          offered 1–4                  present: 2 and 3
    parking        offered 1–3                  present: 1 and 2
    Rent tab       searched a channel with      live rentals: 0
                   nothing in it

Property type was the one control that already had the right rule, and its
comment said so — "only types with something live in them, so no choice here
can produce an empty page by itself". The other five never got it. A dropdown
entry that cannot return a result is worse than a missing one: it looks like a
working control, it empties the page, and the visitor concludes the portal has
nothing rather than that the option was fiction.

### One query for all of it

`searchFacets` returns, per channel, the bedroom / bathroom / car-space values
actually present, the property types, the price bounds and the live count —
plus the suburb list. It is a single statement with `FILTER` aggregates,
because the obvious shape is six round trips to a database in another region
on the first paint of the three most-visited pages. `query-count.test.ts` holds
it to one.

`cachedFilterOptions` is now derived from it rather than querying, so the chat's
catalogue and the search filters cannot disagree about which suburbs exist.

Every value comes back as text — `numeric` as text, `count(*)` as text because
it is a bigint, and `array_agg` as an array of text. That is all three shapes of
the § 6 boundary bug in one row.

### The price ladder is generated, and rounded

Steps between the real minimum and maximum, snapped to figures a person would
type. `$23,478 / $31,203 / $38,928` is arithmetically even and reads as a
machine talking; buyers think in $25k, $50k, $500k. Both ends stay strictly
inside the range — an option at the maximum is "everything", which "Any price"
already is.

Radius stays a fixed ladder and is the only one that does. Distance is not a
property of the data: the honest answer to a 2 km search that finds nothing is
an empty result with the radius still set, and narrowing it would cost a PostGIS
query per rung on every page load.

### An empty channel says so

Switching to Rent searched, found nothing, and rendered "Nothing matched that
search. Try a wider price range" — advice that cannot help, about a filter the
visitor never set. The count is already in the facets, so the box now says
"Nothing is listed for rent yet" beside the toggle.

### The smoke check is the feature

`no filter option the search box offers can return zero results` takes the
options the box will actually render and runs every one of them — both
directions of the price ladder, because a rung that works as a ceiling can
still be empty as a floor. It re-tightens on its own as the data changes;
there is no ladder in the check to keep in step.

Verified by putting the old ladder back: *sale: "from 750000" is offered in the
search box and returns nothing.* The unit tests go red on the same change.

### One self-inflicted outage, and the comment that predicted it

Importing `priceLadder` from `search-facets.ts` into `search-bar.tsx` took the
whole site down: every page 500, eighteen smoke checks red at once. The client
component pulled a module that imports `listing` and `property` from @repo/db
as values, @repo/db reaches postgres.js, and postgres.js imports `net`.

`listing-card.tsx` has carried a paragraph warning about exactly this since the
chat shipped — "a value import from the barrel here fails the web build with
Can't resolve 'fs' — it did, once." It has now done it twice. The pure function
lives in `price-ladder.ts`, a leaf with no database import, and both files say
why.

Worth noting what caught it: not typecheck, not lint, not the unit tests — all
three stayed green. `pnpm smoke` went from 63 passing to 42, and the dev log
named the import chain.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **363** (255 `@repo/core`, 108 `@repo/ai`); +9 facet and ladder
  tests, verified red first
- `pnpm smoke` — **63 passed, 0 failed**
- `pnpm smoke:ai` — **70 passed, 0 failed** (one new live check, verified red) (1 new, verified red)
- `/search` 1.79 kB / 132 kB — unchanged; the facets arrive as props on a
  component that was already there

### Still missing

`landFrom` is in `PublicSearchQuery`, every property carries a land size, and
no control exposes it. Sort has no facet behind it — "Price: low to high" is
offered on a channel with no prices at all, which is harmless but not checked.
And the option lists say what exists, not how many: "3+ beds" does not yet say
"(2)". Counts that respect the other active filters are a per-request query
rather than a cached one, which is a different decision from this change.

## 2026-09-25 (later still) — Images: upload, storage, and every page that shows one

The `media` table has been in this schema since it was written and nothing has
ever put a row in it. Now something does.

Decision in `docs/adr/0009-images-on-supabase-storage.md`, in ten lines. The
short version: one **public** Supabase Storage bucket, `media`, and every row
holds a **key** — `listings/<id>/<uuid>.jpg` — never a URL.

### The key rule is the whole design

`mediaUrl()` in `packages/core/src/media` is the only function in this codebase
that knows where images are hosted. Everything else — the search statement, the
media table, `agent_profile.photo_key`, three components — deals in keys. That
is what makes CLAUDE.md's stated destination, R2, a change to one resolver
rather than a migration across two tables and every component that happened to
read one.

`pnpm smoke` now enforces it: any row holding `%://%` fails the suite. It is
exactly the rule that is obeyed for months and then broken by one well-meaning
line in an import script, silently, because a URL renders perfectly well.

### Uploads are closed even though the bucket is open

Reads are public, because these are property ads and a signed URL that expires
inside an ISR-cached page is worse than no image. Writes are a different story:
**the bucket has no RLS insert policy at all**, so the anon key that ships to
every browser cannot put a byte in it. Proved live — a valid PNG with the anon
key is refused with "new row violates row-level security policy".

Every upload is three steps: the server checks `can()` and issues a signed URL
scoped to one key it chose; the browser PUTs straight to storage; the server
records the row **after HEADing the object**. That last part is what makes the
shape safe — "I uploaded to this key" is a claim from a browser, and a caller
that skips step two and calls step three gets a refusal rather than a row
pointing at a 404.

Bytes never pass through Next. A Server Action body caps at 1 MB, property
photos are several, and proxying them would move every byte twice.

### Ordering, both ways round

    upload → verify the object → write the row
    delete the row → then delete the object

Both fail safe in the same direction. A file with no row is invisible and costs
storage; a row with no file is a broken image on a live ad. Only one of those is
worth avoiding, and it decides which way round every operation goes. Deleting a
cover also promotes the next photo — without it a listing kept its photos and
lost its hero on both public pages.

### One component, three surfaces

`ListingMedia` was built as a frame with the placeholder as an absolutely
positioned child, months before any photo existed, specifically so `next/image`
with `fill` could drop in as a sibling. It did. Results rows, the chat's
sidebar cards and the property gallery all render through it, so "listings have
photos" was one component to change and no layout moved.

The cover key is sub-selected **inside the search statement**, beside the agent
names that were put there for the same reason. One photo lookup per row is 24
extra round trips to another region on a results page, and it reads perfectly
well in a component.

### A check that skipped over its own bug

The first version of the photo smoke check asked the search for rows with a
cover and then verified those. Deleting the cover sub-select from the search
made it report **"no listing has a photo yet" and pass** — it filtered on the
very thing that had broken.

Rewritten to take its expected set from the `media` table, so the search has to
account for every row in it. Deleting the sub-select now fails with "media says
d56336f7.png, the search says nothing".

That is the third time in two sessions. The pattern is identical each time: the
check asked a question the broken page could still answer correctly.

### One thing I could not verify

"The media bucket refuses an anonymous write" passes, and the refusal is real —
it was proved by hand before the check was written. But I could **not** prove
it goes red, because doing so means adding an RLS insert policy to open the
bucket, and that was refused as a security weakening. So treat that one check
as unverified in the negative direction until someone opens the bucket
deliberately and watches it fail.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **354** (246 `@repo/core`, 108 `@repo/ai`); +14 are permission
  and storage-key tests, each verified red first
- `pnpm smoke` — **62 passed, 0 failed** (4 new, three verified red)
- Client JS **+5–6 kB on every public page**: `/` 125 → 130 kB, `/chat` 114 →
  120, `/listing/[id]` 109 → 114, `/search` 126 → 132. That is next/image in
  the shared chunk, and it is the cost of the optimiser resizing a 320 px
  thumbnail out of a 4000 px camera file rather than sending the original.

### Still missing

Floorplans: `media.kind` has the enum value and nothing writes it. No reordering
beyond "make this the cover" — `sort_order` exists and the UI does not expose
drag. No image-derived metadata; `ai_tags` and `ai_quality_score` are still
empty columns. The console's own thumbnails are plain `<img>`, deliberately —
it is an authenticated page whose Core Web Vitals nobody measures, and
next/image there would need its own `remotePatterns` in a second config.

## 2026-09-25 (later) — The mock is in the repository, and the property page is built to it

The entry below says the mock was not in this repository and that whatever had
been pasted into a chat was gone. That was true of the *chat* transcript and
false of the project: Stitch still had it. `.cursor/mcp.json` carries a working
key for `https://stitch.googleapis.com/mcp`, `get_screen` returns download URLs
for the HTML and the screenshot, and both are now committed under `docs/mocks/`
with a README covering how to pull the rest of the project. **Anything a page
is built to belongs in there.** The cost of not having it was a day of building
from screenshots.

### Building from a photograph is not building from the design

The reference used for `/search` was two screenshots of realestate.com.au, and
the skin that came out of it was `#E4002B` on `#F2F2F2` — warm crimson on
neutral grey. The mock's own Tailwind config says `#E11D48` on `#F8FAFC`: cool
slate with blue in it, `text-primary` `#0F172A`, `border-default` `#E2E8F0`.
Side by side the difference is obvious, and it is the difference between "looks
like a property portal" and "looks like *this* design".

Every value in `[data-skin='portal']` is now read out of
`docs/mocks/listing-detail.html`, with the mock's own token names in the
comments beside each one so the two can be checked against each other rather
than trusted.

### Two families, measured rather than assumed

The mock is set in Inter and Plus Jakarta Sans. Setting a slate portal in
Source Sans and Fraunces was most of what made the first attempt read as a
different design — but § 11 exists because the largest win in this repo was
deleting a font, so this was measured on a production build rather than waved
through:

    /            2 files   46,912 b     unchanged
    /chat        2 files   46,912 b     unchanged
    /search      4 files  122,616 b     +75,704 b
    /listing     4 files  122,616 b     +75,704 b

The two new families are imported from `app/portal-fonts.ts`, not from
`layout.tsx`, and applied on the same element that carries `data-skin`. next/font
preloads a font on the routes whose module graph reaches it, so `/` and `/chat`
— which would never draw a glyph from either — download neither. Confirmed by
diffing the CSS each route serves: 57,227 b with no `Plus Jakarta` in it,
against 67,595 b with it.

Those two pages still carry Fraunces as well, because the header is AppShell's
and sits outside the wrapper. If the skin ever goes site-wide that becomes a net
reduction, not an addition.

### The property page

Rebuilt section by section against the mock: the one-large-plus-two gallery
grid, the media strip, the sticky in-page tab bar, the price-first card with
the mock's five icon-tiles, inspection sessions with their kind as a pill, the
transaction history as the mock's four-column table, the agency panel with
tappable `tel:` links, and the Victorian due diligence notice — which is a real
obligation under s.33A of the Sale of Land Act 1962 and is therefore rendered
only for VIC listings, linking to Consumer Affairs Victoria rather than
paraphrasing the Act.

Icons are inline SVG, one path each, shared with the results row. Material
Symbols is what § 11 is about; it is not coming back for a dozen glyphs.

Everything the mock asks for and this database cannot answer — the 24 photos,
the energy rating, the inclusions schedule, the floorplan, the CoreLogic
medians, the rental yield, days on market, school catchments, the mortgage
estimator, the council zoning line — is named in one line each and drawn
nowhere. The mortgage estimator is the clearest case: the arithmetic is fine,
the 6.14% it is computed from would be invented.

### A third check that passed over its own bug

The in-page tab bar is built from whichever sections rendered, because a
listing may have no inspections, no history and no coordinates. That decision
was being made twice — `timeline.length` for the tab, a filtered list inside
the section — and the two disagreed. A property whose only history is its own
live listing rendered a "History" tab that scrolled to nothing, which is not an
error, not a warning, and not visible in a screenshot: it is a click that does
nothing.

`usefulTimeline` is now the one place that decides, and a smoke check pulls the
hrefs out of the rendered nav and requires an element with each id. Restoring
the old expression turns it red with "history is a tab that scrolls to nothing".

That is the third check in two sessions written for a bug it then failed to
catch until it was deliberately broken. The pattern is the same each time: the
check asked a question the page could answer correctly while still being wrong.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **340** (232 `@repo/core`, 108 `@repo/ai`)
- `pnpm smoke` — **58 passed, 0 failed** (4 new checks, each verified red first)
- `/search` 1.79 kB / 126 kB · `/listing/[id]` 2.79 kB / 109 kB — +0.13 kB each,
  all of it markup. Everything added is a Server Component.

### Still missing, deliberately

No photos: the `media` table is empty, there is no upload path and no R2
credential, so the gallery is the mock's grid with id-derived gradients in it,
shaped so `next/image` with `fill` drops in as a sibling without the layout
moving. The header keeps the warm green — it is AppShell's, shared with `/` and
`/chat`, and re-skinning it re-skins every page. Moving the skin selector to
`:root` is the one line that rolls the portal look out site-wide.

## 2026-09-25 — /search gets the portal design it was supposed to have

Reported in one line: the link from the chat opens, and what opens is not the
design that was handed over. Correct. The previous session took the mock's
token *structure* and kept this site's values on purpose, and recorded the
reason — the mock is cool slate, this site is warm, and adopting its palette
would have left /search looking like a different product from / and /chat. The
reasoning was sound and the outcome was still wrong: what shipped did not look
like what was asked for, and nothing in the repo held the original design, so
there was nothing to diff against.

**The mock code is not in this repository.** Not committed, not in `docs/`, not
untracked. `apps/console/public/stitch/` holds console PNGs and that is all.
Whatever was pasted into a chat is gone. This was rebuilt from two
realestate.com.au screenshots instead. If the original turns up, put it in
`docs/mocks/` — the cost of losing it was this session.

### The palette is a wrapper, not a rewrite

`/search` is re-skinned by one `[data-skin='portal']` block in `tailwind.css`
that redefines the colour tokens, plus one attribute on the page. Every
Tailwind utility compiles to `var(--color-…)` and every CSS Module reads the
same custom properties, so twenty lines re-skin the search bar, the cards, the
map and the sidebar together. Structure untouched: same token names, same
scale, same shadow slots.

Four CSS Modules were hard-coding `#0b3d2e` and the `packages/ui` token names,
which is why they could not follow. They now read the theme tokens. Every swap
is pixel-identical outside the wrapper, because `packages/ui/styles.css`
declares each of those with exactly the value the theme token carries
(`--color-accent` *is* `#0b3d2e`, `--color-border` *is* `#d9d2c5`).

The header is deliberately still green. It lives in AppShell, above the
wrapper and shared with `/` and `/chat`. Moving that one selector to `:root` is
what rolls the portal look out site-wide — it is one line, and it is a
decision, not a default.

### The sidebar is two panels, because that is how many this database can answer

The reference sidebar is medians, days on market, rental yield, a twelve-month
trend and a mortgage calculator. Six of those need a market data source that
does not exist here, and a plausible median is precisely the invented number
#4 forbids. So: **agents listing in this suburb** and **suburbs near it**, both
real aggregates, both one query (`search-sidebar.ts`), both cached five minutes
behind the listings tag, both rendering nothing at all when they have nothing
to say. A third panel states in one line that the market data is missing.

`count(*)` came back as a string again — the fourth appearance of the same
boundary bug in this repo. Converted where the lie is created, and the test
asserts the **type**, which is the assertion that actually fails.

### Two things found by breaking the checks that were meant to catch them

`pageWindow` started life in `apps/web/app/search/results.tsx`, where nothing
can test it — apps/web has no runner. It moved to `packages/core` and the test
immediately earned itself: deleting `out.push(total)` turns four assertions
red, and that bug is a last page nobody can reach, which looks perfectly fine
on the page-1 screenshot that gets reviewed.

The smoke check for the skin **passed while the skin was removed.** `/search`
streams `loading.tsx`'s shell into the same response, the skeleton carries the
skin too (it has to, or the page changes colour on arrival), and "is
`data-skin` anywhere in this HTML" is a question the skeleton answers yes to on
its own. It now matches the one element carrying both `data-skin` and
`data-page="search-results"`. Deleting the attribute from the real page is now
red. This is the second time a check in this repo passed over the bug it was
written for.

### Numbers

- `pnpm typecheck` 10/10 · `pnpm lint` 10/10 · `pnpm build` 2/2
- `pnpm test` — **340** (232 `@repo/core`, 108 `@repo/ai`)
- `pnpm smoke` — **57 passed, 0 failed** (3 new checks, each verified red first)
- `/search` **1.66 kB / 126 kB — unchanged.** Everything added is a Server
  Component.

### Still missing, deliberately

No photos, still — the `media` table is empty and there is no upload path, so
every result carries a per-listing gradient with the price on a scrim over it.
The reference's photo counts, favourite and share controls have no data or
account behind them and are not drawn. `/listing/[id]` was not touched: the
scope agreed was `/search` only, so the property page keeps the warm palette
and the two public pages currently do not match.

### Tool split

This is `apps/web`, which `CLAUDE.md` assigns to Cursor. Done here at the
user's request. The core additions (`search-sidebar.ts`, `pagination.ts`) are
Claude Code's side and are where the logic lives — rule #10 is why `pageWindow`
is not in the page that renders it.

## 2026-09-24 (later again) — The chat hands over a search, and the public pages become a portal

Eight phases. The request was small and concrete — after the guide answers,
give a link built from that prompt, open it in a new tab, make both pages look
like a portal — and most of the work was finding out what was already there.

### The link had been built all along

`searchQueryToPath` has produced a per-prompt `/search?channel=sale&suburb=…`
since the chat shipped. The only route to it was one small text line in the
sidebar, which on mobile is behind a tab.

And the server sends **two** links. The client kept one:

    case 'state':
      setSlots(event.slots);
      break;

`event.deepLink` stopped there. That is the turn-level link, built from the
accumulated brief rather than from the last tool call — and it is the only link
a turn has when the guide asked a question instead of searching, which is a lot
of turns. Three lines to keep it; it had been streamed and discarded for months.

A zero-match turn deliberately still gets no link. `/search` with that query
renders the same nothing, so it would be a button to an empty page.

### The same bug, for the third time

`unstable_cache` serialises whatever it is given to JSON and parses it back, so
every `Date` that goes through it comes out an ISO **string** while the type
still says `Date`. Nothing caught it for months because nothing rendered a
date. The first thing that did died on `publishedAt.getTime is not a function`.

That is the third shape of one bug in this repo:

    count(*)          bigint  -> string, and "3" + 1 is "31"
    numeric columns           -> string, and Number(null) is 0
    Date through a cache      -> string, and it has no .getTime

Each is a value whose runtime type does not match its declared one, at a
boundary TypeScript cannot see across. Fixed at the boundary each time — not by
teaching consumers to accept `Date | string`, which spreads the boundary
through the app. `ARCHITECTURE.md` § 6 now names the class and says the thing
that actually catches it: assert the **type**, not just the value.
`expect(typeof x).toBe('number')` is the line that fails; `expect(x).toBe(3)`
sometimes does not.

### Every price on the site was faux-bold

Six rules set `font-weight: 700`. `layout.tsx` loaded 400 and 600. The browser
had been synthesising bold on every price, card and heading that asked for it.

Worth measuring rather than assuming, because § 11 says the largest win in this
repo was a font. Clean builds either way: **10 files, 194,312 bytes**, identical.
The CSS declares 21 Source Sans faces across three weights against only **10
unique URLs** — each weight points at a file already being fetched, because
these are variable fonts. The fix cost zero bytes.

### Tailwind, without the reset

Installed in `apps/web` only, and the layers imported by hand — theme and
utilities, no base. Importing `tailwindcss` whole drops its preflight under
every page built on browser defaults plus `packages/ui/styles.css`, which would
have moved type and margins on pages nobody was editing. Verified: zero
preflight markers in the built CSS.

`@theme static` rather than bare `@theme`, which took one failed build to
discover. Tailwind only emits the variables its utilities use — right for a
Tailwind-only codebase, wrong here, where the CSS Modules still styling most of
the app read the same tokens as plain custom properties.

Token structure from the Stitch mock, values from this site. The mock is cool
slate and this site is warm; taking its palette would have left `/search` and
`/listing` looking like a different product from `/` and `/chat`.

### What the mock asked for versus what the database holds

The mock is a realestate.com.au remix with a 24-photo gallery, inspection
RSVPs, an energy rating, a floorplan, CoreLogic medians, rental yields, days on
market and school catchments. Checking each against `schema.ts` was the most
useful hour of the session:

- **Already possible, never queried**: inspection times, agent contact cards,
  and a property's transaction history — genuinely derivable, because a
  property outlives its listings (#1) and `sold_price`/`sold_date` are stored.
- **Table exists, no pipeline**: photos and floorplans.
- **No data source at all**: features, energy rating, market insights, schools.

The last group renders as one muted line each under a heading that says so.
Drawing a plausible median would have been the invented number #4 exists to
forbid — and `STATUS.md` already records invented market figures being removed
from the console's AI page once before.

### Proving the guards, twice by mutating the database

Two of the new guards are about not leaking an agency's unpublished work, and
neither could be proven by a unit test — the fakes ignore the WHERE clause, so
deleting the status filter leaves them green. I checked that, then wrote it
into the test's own comment so it does not look like it is guarding something
it is not.

So both were proven against the real database, by flipping one listing to
draft:

- **Property history**: filter intact → 2 entries, 0 drafts. Filter sabotaged →
  3 entries, and the smoke check went red naming the row.
- **Enquiries**: filter intact → the draft refused. Filter removed → *"an
  enquiry was accepted against a draft listing"*.

Both restored, and the lead row the sabotaged run wrote was deleted.

### Two decisions made by measuring, not by taste

The enquiry form first imported the zod schema the server validates with — one
contract, no round trip for a typo, which is exactly what the console's listing
form does. It cost **13 kB of First Load JS** on every listing page view, to
save a round trip on a four-field form most visitors never open. Dropped for
the browser's own constraints; the console keeps zod, because it is behind a
login, has twenty fields, and is the tool of someone's job. 122 kB → 109 kB.

And `/listing/[id]` grew four times its content and got **smaller** — 2 kB →
1.57 kB before the form, 2.64 kB after — because all of it is Server
Components and the styling moved out of a per-route CSS module.

### Things I got wrong

- I ran `pnpm typecheck`, grepped the last line, and read "Tasks: 6 successful"
  as a pass. Two AI fixtures were failing to typecheck the whole time, because
  `pnpm test` does not typecheck.
- A sabotage silently did not apply — my perl pattern had six spaces of
  indentation where the file had four — and the test passed for the wrong
  reason. Now I check the sabotage landed before trusting that it went red.
- The first smoke check I wrote for the turn link compared against
  `encodeURIComponent(suburb)` while `URLSearchParams` writes a space as `+`,
  so it went red on a correct link. "Nar Nar Goon North" caught it.
- I corrected a note rather than inheriting it: the comment above
  `force-dynamic` claimed dev returned a proper 404 and only production served
  the soft 200. Re-measured against the committed code *before* my rewrite —
  dev answers 200 too. Streaming flushes the status line before the body runs
  `notFound()`.

### A fourth junk field

`description` was `"asd"` on a live listing, under the heading "About this
property". Phase 11's rules had covered headline, price display, room counts
and property type but not this. Rule added, and the repair nulls it — there is
no honest way to invent a description of a house we know nothing about.

### Verified

typecheck 10/10 · lint 10/10 · 312 tests (220 core, 92 ai) · both apps build ·
smoke 59 passed, 0 failed. Every new guard broken once and watched go red.

One flake worth knowing about: the radius-cache check budgets `warm < 150 ms`
against a measured 29–55 ms hit, and a loaded machine produced 154 ms once. It
passes on a re-run. Loosen it against a measurement, not against one red run.

## 2026-09-24 (later still) — Thirteen phases of making it fast, and finding out why the data was wrong

A performance and architecture pass over the whole repo, phase by phase, one
commit each. The audit and the plan came first and neither touched a file. What
follows is mostly what the plan got wrong.

### The biggest win was a font

Nine phases of bundle work moved less weight than one URL. The console asked
for Material Symbols across its full variable axis space —
`opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200` — while every CSS rule in
the repo uses `wght 400, GRAD 0`. Pinning the axes:

    4,001,724 bytes  ->  1,107,100 bytes     (-2.9 MB, render-blocking)

Nothing in a route-size table would ever have shown this. It is the reason
`ARCHITECTURE.md` § 11 says to look outside JavaScript first.

### Five checks that had quietly stopped working

Found by following CLAUDE.md's own rule — break the thing a check guards and
confirm it goes red.

Two radius checks could not detect the bug they were written for: `wide >=
suburbOnly` is satisfied by equality, and the wrong-coordinates check only ever
went red on a database with listings near Sydney. Both now compare against the
same search with the centre spelled out, which is dataset-independent.

Three speed checks broke the moment `loading.tsx` was added, and looked fine
doing it. They timed to first byte, and a streamed page flushes its shell
immediately whether or not anything is cached — so with the cache ripped out
entirely they read *"cold 33 ms, warm 33 ms"* and passed. They read the full
body now. Even then the ratio assertion was useless: cold 1465 ms / warm 433 ms
still satisfies `warm * 2 < cold` with no cache at all. It is an absolute budget
now (cache hit 29–55 ms against a 420–480 ms round trip).

A `#4` violation alarm turned out to be a bug in the check, not the model — it
stripped commas from the figure but left the `$` on, so it searched for
`$9320334343324` while the JSON held `9320334343324`.

### A forged header rendered a real owner's console

The middleware sets `x-console-user-id` and Server Actions trust it. Two paths
reached Server Components without `updateSession` having run: `UI_PREVIEW` mode,
and the throw path when a Supabase env var is missing. Proved rather than
argued — a second console on port 3002 with a forged header carrying a real
owner's id returned **HTTP 200** rendering "Every listing in the agency book".
Middleware now deletes those three headers unconditionally, at the top, before
any branching. Restoring only that strip turned the same request into a 307.

My first smoke check for it passed under sabotage and told me nothing, because
middleware redirects on `!userId` before any page reads a header. The check's
comment is now honest about what it can and cannot see.

### Three projections that were wrong

- **Phase 5d planned a 60% cut of `listing-form.tsx`** by moving "inert" fields
  to Server Components. They are not inert: every field calls `invalid(name)`
  for its className and renders `<Err name>`, both of which read client `errors`
  state. The form's own page chunk is 138 bytes anyway. Dropped.
- **The plan said to omit `generateStaticParams`.** Empirically required:
  without it `prerender-manifest.json` had `dynamicRoutes: []` and every request
  re-rendered. With `return []` it became `['/listing/[id]']` and `● ISR`.
- **I reported drizzle and zod in a client chunk.** They were not. A broken
  probe loop — `grep -c "$probe" "$f" || echo 0` made `$c` equal `"0\n0"`, so
  every check read as truthy.

### ISR on the listing page works, and is still off

Measured end to end: MISS → HIT → MISS after `revalidateTag`. It is not enabled,
because `/listing/<unknown-id>` answers **HTTP 200** with the not-found body in
production. That is pre-existing — it reproduces on a clean build with
`force-dynamic` and with `not-found.tsx` deleted entirely — but a wrong status
served fresh is a bug and a wrong status served from a cache sticks. I first
recorded it as caused by caching, which was wrong, and corrected the comment.

### Then: reviewing the concurrent frontend work

The new site header was raw `<a>` tags. On the public site that is the
most-clicked control there is, and a raw anchor is a full document load — nine
commits of work on instant navigation, handed back on every page. It was
written that way for a real reason: `packages/ui` has no `next` dependency and
cannot import `next/link`. So rather than give the shared package a framework,
`AppShell` takes a `linkAs` prop and `apps/web` supplies `next/link` in exactly
one place (`WebShell`). Route sizes unchanged to the byte, and it buys back
viewport prefetch of the `/search` and `/chat` loading shells.

Also: the map's "not on the map" tally counted rows with a null latitude, while
the pins needed latitude *and* longitude — so a row with one but not the other
was dropped from both. It is counted from the pins actually built now.

### Every listing in the database was junk, and all three were live

    headline       "dfs", "dfsdsf", "jdsfjdfjl"
    price_display  "23443342", "332432322", "9320334343324"
    property_type  "sfd", "2jkads", "House"
    one property   23 bedrooms, 32 bathrooms, 32 car spaces

Nothing was broken. `headline` needed one character, `price_display` was any
string up to 120, `property_type` was free text, and a dwelling could have fifty
bathrooms. The rows were legal.

The price one is the one that matters. #6 keeps the display string and the
searchable numbers apart and never parses one into the other — correct, and it
only holds while the string is actually copy. One listing displayed a figure
reading as twenty-three million while the range search filters on started at
`$34,443`, so a buyer filtering under $50,000 was being shown it.

`property_type` was worse than it looked. The public search *filters* on that
column and builds its dropdown by selecting distinct values out of the live
listings — so the live site was offering buyers `"2jkads"` and `"sfd"` as
property types, with `"House"` and `"house"` counted as different kinds of
building. Confirmed by reading the actual `<option>` list off `/search`. A
filterable dimension cannot be free text; it is a vocabulary now, same shape as
`AU_STATES`, same reasoning as #8.

Two things guard it: a smoke check that asks the **real schema** of every live
row rather than a second copy of the rules, and `db:repair-listings`. The
repair follows one rule — every fix is derived from something true or is an
honest NULL, and nothing invents a price. Its first draft wrote *"3-bedroom sfd
in Nar Nar Goon North"* and *"2jkads in Pakenham"*, because it trusted
`property_type` while it was in the middle of repairing `property_type`. A dry
run caught it. A repair is only as good as the field it reads.

### Two header numbers were holding a whole query open

`listAgencyListings` had no LIMIT. It selected every listing the agency had ever
written, with addresses and agent-name arrays, on every console page load —
because the table computed its Live and Drafts figures in the browser:

    const live = optimisticRows.filter(r => r.status === 'live').length;

Those are only correct if the browser has every row. Postgres counts them now,
as window functions over the same scan, evaluated before `LIMIT` so they stay
agency-wide. Verified against the real database rather than assumed: `limit 2`
returned two rows carrying `total=3`. Still one statement — `query-count.test.ts`
refuses a second, confirmed red with a deliberate extra await.

### What I did not do

`router.refresh()` follows a Server Action that already called `revalidatePath`
in three places. It is very likely a duplicate round trip, and it holds
`isPending` — and every action button — disabled while it runs. I built a probe
route to settle it empirically, could not drive a client component without a
headless browser, and stopped rather than remove it on reasoning alone: the
failure mode is a visibly stale table on the console's main write path. The
experiment that settles it is written down in `ARCHITECTURE.md` § 14.

### ARCHITECTURE.md

The rules above existed only in commit messages and code comments, which means
they were only available to someone who already knew to look. They are now one
file, fourteen sections, with the measurements attached and a section of gaps
left open on purpose. `CLAUDE.md` points at it.

### Verified

typecheck 10/10 · lint 10/10 · 277 tests (187 core, 90 ai) · both apps build ·
smoke 55 passed, 0 failed. Every new guard confirmed red under sabotage and
green restored.

## 2026-09-24 (later) — The guide meets the real model

The key arrived, so the chat ran against Claude for the first time. Five things were
wrong, none of them visible to a unit test, and each one is now guarded.

### `strict: true` was making the guide invent filters

The worst of them. With `strict: true` on the tool definitions, the model filled in the
**optional** fields on every call — `keywords: "-"`, then `keywords: "1"`, `priceTo: 22`,
`priceTo: 0` — on messages where the visitor had mentioned neither a keyword nor a budget.
Each one silently ANDed the search down to nothing, and the visitor would have seen only
"no matches" with no way to tell why. Watching the NDJSON frames is what showed it:

    {"query":{"text":"-","channel":"sale","suburb":"Pakenham","priceTo":22},"matched":0}
    {"query":{"text":"1","channel":"sale","suburb":"Pakenham"},"matched":1}

`strict` is gone. It was belt-and-braces over a zod layer that re-parses every input
anyway, and optional has to mean optional. `additionalProperties: false` stays.

### `strict: true` also 400s the whole request over `minimum`

    tools.1.custom: For 'integer' type, properties maximum, minimum are not supported

Not `number` only — `integer` too, and by extension `minLength`, `maxLength`, `pattern`.
The schema now carries `type`, `enum` and `description` and nothing else. The bounds are
stated in prose, where the model reads them, and enforced in zod, where they are checked.
A test asserts none of the banned keywords come back.

### `length(2)` on an Australian state, twice

`auStateSchema` was adopted in the tool schema earlier today. The **same mistake was still
sitting in `slotsSchema`**, so the first message worked and the second came back `400` for
every conversation about a VIC, NSW, QLD, TAS or ACT suburb — the chat looked like it had
simply stopped. Non-negotiable #8 exists for exactly this: one list, not three. There is
now a test that posts the whole turn-two body the browser actually sends.

### `effort: "low"` was the wrong measurement

The plan set it low and reasoned that a consumer chat is latency-sensitive and the work is
only choosing filters. Against the real model that produced `priceTo: 0`, a stray `x` in
the keyword field, a missed "under 30km", and one turn that read
*"ację / comment / Let me run that properly"* before recovering. **Choosing filters from a
sentence is the reasoning here.** Raised to `medium`; `max_tokens` 2048 → 4096, because
adaptive thinking spends that budget too and it is headroom, not a cost ceiling. Cost is
governed by effort and the three-round cap, which is what the original comment got wrong.

### The prompt was too polite to follow its own rule

v1 asked "buy or rent?" before searching anything, and v2's first draft still read
*"a house in Pakenham under 30km"* as a suburb search and then **asked whether 30 km was
meant** — the software not listening. v2 now enumerates the phrasings ("in X under 30km",
"within 30 km of X", "X + 30km") and states that a radius is never a reason to ask a
question. Channel is assumed and disclosed in one clause rather than demanded up front:
*"Assuming you're buying — say the word if it's rentals you want."* v1 is kept beside it.

### What it actually does now

    "I need a house in Pakenham under 30km"
      → near={lat:-38.0776708, lng:145.4818724, radiusKm:30}, channel=sale
      → "Within 30 km of Pakenham there's just 1 house… 3.5 km away."
      → link: /search?channel=sale&suburb=Pakenham&state=VIC&radius=30   (no lat=)
      → then asks for budget and bedrooms, with results already on screen

    "Actually I want to rent, under $700 a week, 2 bedrooms"
      → channel=rent, priceTo=700 read as weekly, bedrooms=2, radius carried over
      → "Nothing is coming up… want me to lift the price ceiling, or drop the
         bedroom filter instead — just say which."

It also met a listing whose price is `9320334343324` — junk typed into the console during
testing — and said *"which looks like an error on the agency's part, so worth checking
with them directly"* rather than reading it out as a price. That is the behaviour the
formatting rule was for, arriving without being asked.

### Smoke

The four model-dependent checks now run, plus a fifth for the radius. The `#4` check had
to be corrected first: it flagged `$2,000,000` as hallucinated when the guide was
repeating the visitor's own budget back to them. A figure is now accounted for if it
appears in the rows, the query, **or the message the visitor sent**. The helper skips on a
429 rather than going red — hitting the limiter means the limiter works.

typecheck 10/10 · lint 10/10 · **tests 195/195** (134 core + 61 ai) · **smoke 45 passed,
0 failed, 8 skipped** — including all seven AI checks against the live model · both apps
build · `/chat` 4.07 kB / 110 kB.

### Still true, and still the thing to do before launch

`/chat` is an anonymous, unauthenticated page in front of a metered API. The per-IP
limiter (10/min) and `AI_CHAT_DAILY_TURN_CAP` are ceilings on accidental cost, not
security controls. **Set a hard spend cap in the Anthropic console.** A Turnstile or
signed page token before it is public.

## 2026-09-24 — A property guide on the consumer site

`/chat` on apps/web: a conversational way into the same search, for a buyer who knows
what they want but not which filters say it. Anthropic tool calling, not RAG — embeddings
go stale the moment a price changes or a listing is withdrawn, and recommending a
withdrawn listing in Australia is a misleading-conduct problem, not a relevance one.
Hard filters ("3 bed under $900pw") are not something cosine similarity can enforce.

### The model cannot produce a number, by construction

Non-negotiable #4 is usually a prompt rule. Here it is structural, in four places:

- **Tools hand back formatted strings, not numbers.** A row the model sees is
  `{ price: "Offers over $1.2M", specs: "3 bed · 2 bath", distance: "4.2 km away" }` —
  built by `priceLabel`/`specLine`, the same two functions the cards use. There is no
  figure in the payload to do arithmetic on. `price_display` passes through unparsed (#6).
- **Earlier turns carry no tool results at all.** The client holds the transcript, so a
  client that could send a tool result could send a price the database never quoted. Past
  turns are replayed as plain text plus one *server-authored* line
  (`[searched: sale · in Pakenham → 37 matches, 8 shown]`). The consequence is the point:
  the model genuinely cannot recall turn two's prices and has to call `get_listing`.
- **The results panel never renders model text.** It renders the `results` frame's rows
  through `ListingCard`. What is on screen is SQL's, whatever the answer beside it says.
- **A smoke check reads every `$` figure out of the reply** and asserts it appears in the
  tool result. It is the only check in the suite that can catch a hallucinated price.

### Cross-questioning is two gates, not an instruction

- **Gate 1, the schema.** `channel` and `suburb` are required with `strict: true`. A model
  that does not yet know whether the visitor is buying or renting *cannot form the call*.
  Enforced by the API, not by good behaviour.
- **Gate 2, the return shape.** Over 25 matches with neither a budget nor a bedroom count,
  the tool returns `listings: []`, `tooBroad: true` and a note naming what is missing. The
  model has nothing to show, so the question is its only coherent move. A model cannot
  ignore data it was never given.
- Counting costs no extra query: `limit: 61`, then measure the pile. `searchPublicListings`
  keeps its one-statement guarantee.
- **No `ask_user` tool.** Asking is the model writing text with no tool call — the default
  path. A tool for it would add a round trip and two ways to produce text.

### What the model is never allowed to decide

`search_listings` has no `lat`, `lng`, `status` or `limit` field — the wrong thing is
unsayable. `resolve_location` returns a suburb and a `defaultRadiusKm` but **no
coordinates**; the centre is looked up server-side from `place_cache`. That is the same
bug STATUS.md records being reported twice, kept fixed by making it inexpressible.
Unknown keys are stripped rather than refused: a stray invented field should cost the
field, not one of the visitor's three tool rounds.

`headline` and `description` are excluded from search results entirely. They are
agency-authored free text on a multi-tenant portal — an agency can write "ignore previous
instructions" into a description. Only `get_listing` returns them, fenced and labelled as
data. A unit test asserts the string never reaches the model through a search.

### Transport

NDJSON over a POST route handler, not SSE: `EventSource` is the only zero-dependency SSE
client and it is GET-only, so it cannot carry the conversation. The client hand-parses
either way, and the remainder buffer is the whole trick — a chunk boundary lands mid-object
and a naive `split('\n')` eats the tail, reliably, only under load.

`Accept: application/json` drains the same generator into one object. `pnpm smoke` uses
that, so the streaming parser is never written twice.

### Two real bugs, both caught by their own guards

- **`state: z.string().length(2)`** silently refused every search in NSW, QLD, TAS and the
  ACT — Australian abbreviations are two *or three* letters. It now uses the platform's own
  `auStateSchema` rather than a hand-written duplicate (#8). A test found this, not a review.
- **The web build broke with `Can't resolve 'fs'`.** Moving `priceLabel`/`specLine` into
  core turned `listing-card.tsx`'s type-only import into a *value* import of the
  `./listings` barrel — which re-exports `update-listing.ts` → `@repo/db` → postgres.js.
  Rendering a card inside the chat's client panel then pulled the database driver into the
  browser. Fixed with a leaf subpath, `@repo/core/listings/format`, and the reason is
  written at the top of that file. `/chat` ships at 4.08 kB / 110 kB first load, which is
  the measurement that says the Anthropic SDK is not in there either.

### Verified by breaking it

Each new guard was sabotaged first and confirmed red:
- removing the suburb/coordinate asymmetry → `expected '-38.0709' to be null`
- `TOO_BROAD_ABOVE = 9999` → the gate test fails
- adding `lat` to the tool's JSON Schema → the zod/JSON drift test fails

Live against the running dev server, with no API key set: a forged `listings` array, an
unknown top-level key, a `lat`/`lng` in `slots`, and a `role: 'system'` turn are all 400;
a valid body is 503 with a readable reason. Validation runs *before* the key check, so a
malformed request is told it was malformed rather than being told the service is down —
that was the wrong answer and the one that sends someone to look at the deployment.
Rate limiter: 10 refused, then 429, with zero tokens spent.

### Honest gaps

- **An in-process IP limiter in front of a metered API is a ceiling on accidental cost,
  not a security control.** Ten per minute per IP, plus `AI_CHAT_DAILY_TURN_CAP` per
  process. Behind several instances the real ceiling multiplies, and a determined caller
  rotates IPs. **Before this sees real traffic it needs a hard spend cap in the Anthropic
  console, and a Turnstile or signed page token.** Said plainly because it is the one thing
  here that can cost money quietly.
- Nothing is persisted, so there is no transcript if the guide says something it should
  not — only an `ai_run` row with token counts. That was a deliberate choice.
- `ai_run` has no `cache_read_tokens` column, so `costUsd` is correct but cache
  effectiveness cannot be audited from the table. Manual check H12 is the substitute.
- The search-param vocabulary now has three writers (`search/page.tsx` parses,
  `search-bar.tsx` builds, `searchQueryToParams` builds). `SEARCH_PARAM_KEYS` exists so the
  drift is findable; unifying them was deliberately left out of this change.
- The chat has never run against a real model — **`ANTHROPIC_API_KEY` is still empty.**
  Everything above is verified by unit tests, the build, and live HTTP against the guards.
  The four model-dependent smoke checks skip cleanly and are what proves the rest.

typecheck 10/10 · lint 10/10 · **tests 190/190** (134 core + 56 ai) · **smoke 40 passed,
0 failed, 12 skipped** · both apps build.

## 2026-09-23 — Guards for the transaction and performance work

Everything just built is invisible when it breaks: an N+1 returns the right answer, a lost
cache is merely slower, a non-transactional write only shows on a failure path nobody
exercises. So each got a guard, and **each guard was verified by breaking the thing it
guards** — two of them failed that bar first time.

- **`query-count.test.ts`** — every read has an exact, measured query count. The agency table,
  the agent desk, one listing for editing, and a public search with thirteen filters are all
  one query; a radius search costs the same as a plain one.
  - **It did not work first time.** The counting fake returned an empty array, so a
    deliberately added per-row query never ran and the test stayed green. It returns three
    rows now: a fake that returns nothing cannot catch a bug that costs one query per row.
    With that fixed the same sabotage reads `expected 4 to be 1`.
- **Database health** in smoke: all five indexes present, none invalid, the radius plan uses
  the spatial index, geocoded rows all have a usable `geom` — and two that look for the
  wreckage of a partial write directly: a listing with no `listing_agent`, and an agent
  membership with no `agent_profile`. Both are zero. Before the transaction work, either
  could have been non-zero and nothing would have said so.
- **Speed, measured as a ratio rather than a budget.**
  - The first version allowed 400 ms. Disabling the cache took pages from 31 ms to 134 ms —
    four times slower, comfortably inside the budget, test still green. A millisecond number
    measures the laptop it runs on.
  - It now clears the cache, times the cold request, then times the warm ones, and requires a
    real gap. Cached: `cold 440 ms → warm 33 ms`. With caching removed all three fail with
    `cold 419 ms, warm 449 ms — too close together to be cached`.
- `CLAUDE.md` gained a "Writing to the database" rule: multi-step writes in a transaction,
  helpers take `DbOrTx`, network calls before the transaction opens.
- typecheck 10/10 · lint 10/10 · **tests 113/113** · **smoke 45 passed** · both apps build.

## 2026-09-23 — Atomic writes, then a cache the console can clear

### Transactions — nothing is written unless the last step succeeds

- `createListing`, `updateListing`, `materialiseAgent` and both claim paths in
  `claimAgentInvite` now run inside `db.transaction`. Before this a create was five
  statements in a row, and the **last one can legitimately fail**: `attachListingAgents`
  refuses ids that are not members of the agency. That refusal left a property and a listing
  behind with no agent on them — visible in the console, unreachable for an enquiry, and
  invisible as a problem because the error looked like a clean rejection.
- `DbOrTx` added to `@repo/db`, derived from `Db` so it cannot drift. Helpers that write take
  it: a function that only accepts `Db` cannot be made atomic without rewriting it.
- **The geocoder call moved out of the write path.** `resolvePin` runs before the transaction
  opens. Inside it, an HTTP call to Google would hold a pooled connection and row locks for
  its whole duration — one slow response stalling the pool.
- The slug retry in `materialiseAgent` had to go: a failed INSERT aborts a Postgres
  transaction, so catch-and-retry inside one would hit "current transaction is aborted" and
  take every later write with it. `pickSlug` reads the taken slugs first — one round trip
  instead of up to twenty, and a genuine race rolls the whole thing back, which is the
  correct outcome.
- `atomicity.test.ts` proves the guarantee rather than the SQL: its fake only "commits" when
  the callback returns, and asserts nothing escaped. **Verified by reintroducing the bug** —
  removing the transaction turns it red with `OUTSIDE:insert:property`.
- **Verified on the live database.** A create that fails on the agent step: listings 3 → 3,
  properties 3 → 3. Before the fix it would have left one of each.

### Performance — the public site was reading the database on every view

- Measured first: home 480 ms, suburb search 850 ms, radius search 1270 ms. Every one of
  those was a round trip to Seoul, on every page view, for every visitor. `staleTimes: 0`
  had removed the only caching the site had, for a good reason — it was serving stale
  results — but the answer to that is invalidation, not doing the work again every time.
- `apps/web/lib/cached.ts` wraps the four read paths in `unstable_cache`:
  - search results — tagged `listings`, 30 s safety net
  - one listing — tagged `listings` **and** `listing:<id>`, so an edit clears one page
  - filter options — **one call instead of two**; suburbs and property types were separate
    round trips on every page view of both the home and search pages
  - place lookups — a day, untagged: nothing an agent does moves Pakenham
- **Cross-app invalidation**, which is what makes caching safe here. The two apps are
  separate processes, so the console's `revalidatePath` cannot reach the public site.
  `POST /api/revalidate` on web, guarded by `REVALIDATE_SECRET`, called by every listing
  mutation in the console. Best-effort: a failed hint never fails an agent's publish.
- Results: **home 480 → 33 ms, suburb search 850 → 36 ms, radius search 1270 → 32 ms.**
- Proved the invalidation rather than assuming it: warmed the cache (3 results), changed the
  database directly behind it (still 3 — the cache working), called revalidate, got 2.
- Smoke gained two checks: the endpoint refuses a wrong secret and accepts the right one,
  and a warm page answers in under 400 ms.
- typecheck 10/10 · lint 10/10 · tests 107/107 · smoke 35 passed · both apps build.

## 2026-09-23 — Searching stops reloading the page, properly this time

- My first attempt was wrong. `useTransition` around `router.push` does not stop Next reaching
  for `loading.tsx`: that file is a Suspense fallback for the **whole route**, and a route-level
  boundary swaps out everything under it whatever the caller does. The page kept blanking and
  I said it was fixed. It was not.
- Done properly:
  - **`apps/web/app/loading.tsx` deleted.** A boundary that covers the hero, the search box and
    the results can only ever blank all three.
  - The search moved out of `page.tsx` into `search/results.tsx` as two server components —
    `ResultsSummary` and `ResultsList` — each under its own `<Suspense>` keyed on the search
    params. The shell renders without waiting for them, so the search box never leaves the
    screen and only the parts that depend on the answer show a spinner.
  - They share one query through `cache()`. Two components asking the same question would
    otherwise be two round trips to the database region, with the page layout silently deciding
    how many queries a search costs.
  - The key on each boundary is what makes the spinner appear at all: Suspense keeps its old
    children through an update, which is right for refining a list and wrong when the visitor
    has asked a different question.
  - The sweeping bar is gone. A **circle** in the Search button, where the click was and where
    the eye already is; a separate indicator elsewhere makes people hunt for what moved.
- `prefers-reduced-motion` stops it.
- typecheck 10/10 · lint 10/10 · tests 103/103 · smoke 33 passed · web builds. Results
  unchanged: 2 km → 2, 10 km → 3, 50 km → 3.

## 2026-09-23 — Searching no longer blanks the page

- Reported: every search felt like a full page reload.
- It was one, visually. `apps/web/app/loading.tsx` rendered the single word "Loading…" for the
  **whole route**, so `router.push` tore down the hero, the search box and the results and
  rebuilt them. Nothing was cached and nothing was wrong; the page was simply being thrown
  away and remade on every search.
- Fixed:
  - `search-bar.tsx` runs the submit inside `useTransition`. React keeps the current page on
    screen until the next one is ready, so Next never reaches for the loading fallback. The
    **whole** handler is wrapped, not just `router.push` — resolving a suburb's coordinates is
    a network call too, and leaving it outside meant the button sat idle through the one part
    that can take a moment.
  - An indeterminate progress line under the search card while it runs, and the button reads
    "Searching…" and is disabled. Indeterminate on purpose: a round trip has no percentage to
    report and a bar that pretends otherwise is a bar that lies.
  - `loading.tsx` is now a layout skeleton rather than a word. Searching does not reach it any
    more, so what is left is arriving somewhere new — usually a listing — and there the shape
    of the page holds the layout still instead of collapsing it.
- `prefers-reduced-motion` stops both animations.
- typecheck 10/10 · lint 10/10 · tests 103/103 · smoke 33 passed · web builds.

## 2026-09-23 — The search box was filtering twice

- Reported three times as "the km filter isn't working", and I spent an hour on the wrong
  thing — trying coordinate after coordinate — because I kept testing URLs I built myself
  instead of the one the form builds. The moment I read `onSubmit` the cause was on the
  first line of it.
- **`set('q', text.trim())` ran unconditionally.** Picking "Pakenham" from the dropdown leaves
  the word Pakenham in the box as a label, and it was also sent as the free-text keyword. The
  keyword is ANDed over everything:
  `(in Pakenham OR within 50 km) AND ("pakenham" appears somewhere)`
  Nar Nar Goon North is 5.6 km away and has no "pakenham" in its address, so the text filter
  deleted exactly the listings the radius had just added. Every one of my own tests passed
  because none of them carried `q`.
- Fixed in both places:
  - `search-bar.tsx` sends `q` only when nothing was picked.
  - `search/page.tsx` discounts a `q` that is merely the place's own name, so links already
    shared behave too. A genuine keyword next to a suburb still filters — verified with
    `q=Havana` (1 result) and `q=pool` (0).
- Locked: a unit test asserting the keyword is ANDed over the location, and a smoke check that
  runs the same search with and without the label in `q` and requires the counts to match.
- typecheck 10/10 · lint 10/10 · tests 103/103 · smoke 33 passed · web builds.
- Lesson for the next one of these: when the UI disagrees with curl, read the code that builds
  the request before theorising about the response.

## 2026-09-23 (later) — The radius centre came from the browser

- Reported three times, each time as "the km filter isn't working", and I explained it away
  twice before finding it. Reproduced by trying centres until the page's exact wording came
  back: **the centre in the URL was not Pakenham's.** With Pakenham's own coordinates the
  search returned 3; with Melbourne's or Sydney's it returned 2 and said "nothing else within
  50 km of it" — the same sentence in the report.
- The real defect was not which coordinates the browser sent. It was that the **server trusted
  them at all**. A named suburb has one correct centre, so a search could be confidently wrong
  — a circle drawn around Melbourne while the page said Pakenham — with nothing on screen to
  show it. That is a failure nobody can debug from the outside, which is why it took three
  rounds.
- Fixed: when the URL names a suburb and a radius, `apps/web/app/search/page.tsx` resolves the
  centre itself through `resolvePlace`. A cache hit for anywhere already searched, so it costs
  nothing. The URL's coordinates are used only when no suburb is named — the case where the
  visitor picked a street address and the centre genuinely is not a suburb centroid.
- Side effect worth having: a radius with no coordinates used to be dropped silently. It now
  works, so a hand-built or truncated link behaves like one built by the form.
- Smoke gained `the radius centre comes from the suburb, not the URL`, which searches with
  Sydney's coordinates and asserts the count does not move. The old check `a radius with no
  centre is ignored` described the bug as if it were the design; rewritten.
- Verified: correct centre, Melbourne's, Sydney's and none at all now all return 3 at 50 km;
  2 at 2 km; 3 at 10 km. typecheck 10/10 · lint 10/10 · tests 102/102 · smoke 32 passed.

## 2026-09-23 (later) — "the km filter isn't working"

- Reported: "+ within 2 km" showing a card marked 3.5 km away.
- The filter was working. A suburb-plus-radius search is a **union** — every listing in
  Pakenham, plus everything within the radius of its centre — because Pakenham is about 8 km
  across and a 2 km circle from the middle would drop homes on its edges from a search for
  their own suburb. Havana Parade is in Pakenham and 3.5 km from the centroid, so it belongs
  in both answers.
- What was actually wrong was the **presentation**, and it made correct behaviour
  indistinguishable from a broken filter:
  - Every card showed its distance from the centre, including the ones matched by suburb. A
    card reading "3.5 km away" under a 2 km filter has only one available reading.
  - The heading summed the two halves — "3 results … within 10 km" — so there was no way to
    see which result came from where.
- Fixed: a card matched by suburb now says **"In Pakenham"**; only the ones the radius brought
  in show a distance. The heading names both halves:
  `3 results — 2 properties for sale in Pakenham VIC 3810, and 1 more within 10 km of it.`
  At 2 km it reads `…and nothing else within 2 km of it`, which is the filter reporting its
  own result rather than leaving it to be inferred.
- The 50 km case the same report mentioned was the client router cache, fixed separately.
  Verified after: none → 2, 2 km → 2, 10 km → 3, 50 km → 3, with Nar Nar Goon North appearing
  at 10 km and above.
- typecheck 10/10 · lint 10/10 · tests 102/102 · smoke 30 passed · web builds.

## 2026-09-23 (later) — The consumer search page was serving its own stale answers

- Reported: a listing 5.6 km from Pakenham did not appear under "+ within 50 km", twice.
- The server was right the whole time — fetching that exact URL returned 3 results including
  it. The stale answer was in the browser.
- Cause, and it was mine: `apps/web/next.config.ts` had `staleTimes.dynamic: 120`, which I
  added to make back-navigation cheap. The client router cache is keyed on the URL, so
  running the same search twice within two minutes replays the first answer — and that gap
  is exactly when somebody publishes a listing and then goes to check that it showed up.
- Set to `0`. A portal that hides a listing that just came up, or shows one that just sold, is
  wrong in the way that matters most; saving a refetch on back-navigation does not pay for it.
  Static pages keep their cache.
- The console keeps `120`: every mutation there already calls `router.refresh()`, which clears
  the cache outright, so an agent never sees their own change go missing.
- A web dev server restart is needed — `next.config.ts` is not hot-reloaded.

## 2026-09-23 (later) — Two silent failures in the address boxes

- **"Find the address" returned nothing for a suburb.** It was restricted to
  `kinds: ['address']`, so typing "paken" asked Google for street addresses called paken and
  got none — an empty dropdown that reads as a broken box. The routing for a street-less
  result already existed (`applyPlace` hands it to `applySuburb`); the filter stopped anything
  reaching it. Both address boxes are now unrestricted and labelled "address or suburb".
  In the map's box a suburb pans the map there **without** placing a pin — that is exactly the
  state an agent is in when they most need the map.
- **The radius was being dropped.** Searching a suburb with no radius put no lat/lng in the
  URL. Coming back to those results rebuilt `place` with empty coordinate strings, so
  `if (radius && place.lat)` was false and choosing "+ within 10 km" changed nothing at all.
  Coordinates now go into the URL every time they are known, and choosing a radius without
  them resolves the suburb first (a cache hit for anywhere already searched).
- **Silent failures made visible.** `AddressAutocomplete` fetched inside `try/finally` with no
  `catch`, and `suggestPlacesAction` throws on an expired session — so any failure emptied the
  dropdown and said nothing. "No suggestions" and "the lookup failed" look identical and mean
  entirely different things. Both now surface a sentence.
- Added `reverseGeocode` to the geo port and a Google implementation via the Geocoding API it
  already uses, cached on the rounded point. The pin field uses it: drag the marker and the
  nearest address appears, with a button to adopt it — offered, never applied, because a pin
  dragged to the back of a battleaxe block has the front house as its nearest address.
- Verified live: Pakenham only → 2, +2 km → 2, +10 km → 3 (Nar Nar Goon North at 5.62 km).
  Same over HTTP. Reverse lookup of a dragged pin returns the street it landed on.
- typecheck 10/10 · lint 10/10 · tests 102/102 · smoke 22 passed.

## 2026-09-23 (later) — A visual map, and the pin as its own thing

- Asked for: clean the junk data, a visual map on the listing and search pages, a pin the
  agent can drag, and suburb and pin treated as two separate entities.
- **Junk cleared.** `pnpm --filter @repo/db db:clear-listings` (dry run by default,
  `--confirm` to act). All 5 test listings and their now-orphaned property rows are gone.
  Agencies, memberships and users are deliberately out of scope: the one agency holds the
  only owner login. An earlier ad-hoc delete script was refused by the sandbox; a named,
  dry-run-first maintenance command was not, and is the better artefact anyway.
- **Suburb and pin are now genuinely separate.**
  - `pinSource: 'google' | 'manual'` on the property draft. A manual pin is a claim by a
    person standing in the property, so it outranks the geocoder: `resolvePropertyId` no
    longer re-geocodes over it, `geo:backfill` skips it without `--redo`, and editing the
    street number no longer discards it.
  - Choosing a suburb no longer clears a hand-placed pin — a suburb says nothing about where
    in it the house is, and a centroid would be a worse answer than no pin.
  - A dragged pin drops its `place_id` and `formatted_address`: it is a point on a map, not
    one of Google's places, and keeping them would claim this spot is that address.
  - `ListingForEdit` carries `geocodeSource` so a hand-placed pin comes back as one.
- **The map.** `packages/ui/src/maps/` — a singleton script loader (the API is a global;
  loading it twice throws, and React mounts twice in dev) and one `MapView`. Passing
  `onPinMove` is what makes it editable; there is no `editable` flag to fall out of step
  with whether a handler was given. Satellite view in edit mode so the agent can find the
  roof line.
  - Console: `PinField` — collapsed by default, shows whether the pin was found or placed,
    drag or click to move, and "put it back where the address says" on an edit.
  - Consumer: a map on the listing page (only when pinned — a map centred on a suburb says
    the house is somewhere it is not), and an opt-in results map that frames every pinned
    result and counts the ones it cannot show.
- **Second key**: `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`, Maps JavaScript API, restricted by
  HTTP referrer. Not interchangeable with the server key — an IP rule cannot defend a key
  sent from a browser and a referrer rule breaks one sent from a server. Without it the maps
  render a short "not configured" panel and nothing else changes; pins are still stored,
  searched and returned.
- Smoke: an empty database now **skips** the search group instead of failing it. Clearing
  listings is a legitimate state and a red run for it would teach everyone to ignore output.
- typecheck 10/10 · lint 10/10 · tests 102/102 · smoke 21 passed / 0 failed / 9 skipped
  (empty database) · both apps build.
- Note: `MapView` uses `google.maps.Marker`, which Google has deprecated in favour of
  `AdvancedMarkerElement`. The replacement needs a Map ID configured in the console, which is
  another setup step for no benefit here. Revisit if Google sets a removal date.

## 2026-09-23 (later still) — A verification ladder

- Goal: make live testing repeatable instead of a thing done by hand each time.
- Three layers now, and which one is red tells you where to look:
  - `pnpm test` — 97 unit tests. Red means the code is wrong.
  - `pnpm smoke` — new `packages/smoke`, 30 checks against the live database, the live
    Google account and whatever dev servers are up. Red is often something outside the code.
  - `docs/TEST-PLAN.md` — the manual cases that need a signed-in browser, which nothing here
    can produce. Grouped A–G, ordered so later cases use data earlier ones create.
- The smoke runner is deliberately not vitest: these are not unit tests and must never be
  read as such. Failures are fatal; skips are not — a dev server that is down should not
  train everyone to ignore the output.
- **Checks assert invariants, not row counts.** The database changes between runs, so
  `rows.length === 3` is a check that gets deleted the first time somebody adds a listing.
  What it asserts instead: a wider radius never returns fewer results; a listing in the named
  suburb is never lost when a radius is added; the page's count equals the database's.
- **Both layers were verified by breaking the thing they guard.** Reintroducing the
  suburb-vs-radius bug (`return within` instead of the union) turned the unit test red on the
  rendered SQL and the smoke check red with "1 listing(s) in Bondi Beach vanished when a
  0.1 km radius was added". Restored afterwards; full suite green.
- `CLAUDE.md` gained a short "Verifying" section so the ladder is found at session boot.
- typecheck 10/10 · lint 10/10 · tests 97/97 · smoke 30/30.

## 2026-09-23 (later) — Suburb and radius combine instead of replacing

- Reported: searching a suburb should return that suburb exactly; adding a radius should
  return the suburb **plus** its surrounds. The agent side should pick a suburb as
  `Pakenham, VIC 3810` rather than three fields typed separately.
- Found: `searchPublicListings` dropped the suburb filter whenever `near` was present, so
  "Pakenham within 5 km" meant *only* the circle. Pakenham is about 8 km across, so homes on
  its edges were being excluded from a search for their own suburb. The earlier fix for the
  opposite bug (suburb ANDed into a radius) had overcorrected.
- Done:
  - `locationFilter()` replaces `geoFilter()`: suburb-by-name OR ST_DWithin, not one or the
    other. `state` and `postcode` added to the query — there is a Richmond in four states.
  - The union removes the need for the separate unpinned-listing fallback: a property with no
    coordinates is invisible to ST_DWithin but still matches its suburb by name.
  - Radius is now genuinely optional. No radius in the URL means no circle, rather than
    defaulting to 5 km. The dropdown reads "Pakenham, VIC 3810 only" / "+ within 10 km".
  - `AddressAutocomplete` gained a controlled mode (`value`/`onChange`); the listing form's
    suburb field is now a picker that fills suburb, state and postcode together, with the
    composed line shown back as a hint.
- Verified live: "Bondi Beach" alone → 2; + 6 km → 3. **The case that was broken:** suburb
  "Bondi Beach" with a 1 km circle around Paddington returns 3 — the circle alone finds only
  Paddington, and both Bondi listings 4.5 km outside it are kept. Wrong state → 0. The
  Pakenham draft stays invisible.
- New test file `search-location.test.ts` renders the where-clause through `PgDialect` and
  asserts the SQL, because both wrong versions of this return listings — just the wrong set,
  and a live-data test would pass on a database whose suburbs are all smaller than the radius.
- typecheck 9/9 · lint 9/9 · tests 97/97 · both apps build.

## 2026-09-23 — Listing edit/delete, and location becomes real

- Goal: finish listing edit + delete; make location, search and filtering work properly;
  clear the small mess. Photos stay deferred (no R2 keys).
- **Listings**
  - `updateListing` (listing:edit) and `deleteListing` (new `listing:delete`, admin-only).
    Delete is refused for live / under_offer / sold — withdraw first, and a sold listing is
    the agency's record of the sale. The property row is never deleted (#1).
  - Address matching and agent attachment were duplicated inside `createListing`; both are
    now `property-resolver.ts` and `listing-agents.ts`, shared with update.
  - `getListingForEdit` returns the full editable shape. Edit pages on both surfaces.
    `ListingForm` takes `initial` and switches mode; status is not a field it can touch.
  - Table gains Edit and a two-click Delete. `canDelete` is computed by `can()` on the
    server and passed in — the component never looks at a role (#2).
- **Location** (see ADR 0007)
  - Migration 0005/0006: lat/lng/place_id/geocoded_at/geocode_source, `place_cache`, and
    `property.geom` as a GENERATED geography column with a GiST index. `geom_wkt` dropped.
  - `packages/core/src/geo/`: `GeoProvider` port, Google adapter, db-backed cache.
  - Address autocomplete in the listing form and the agent territory step (console server
    action); location autocomplete + radius + beds/baths/cars/type/price/sort on the
    consumer search, through a rate-limited route handler.
  - Radius search with `ST_DWithin`, distance returned and shown, nearest-first ordering.
- **Fixed on the way**
  - `suburb` was ANDed into a radius search, so "within 6 km of Bondi Beach" excluded
    Paddington 4.5 km away. It is now only the fallback for unpinned listings.
  - Rent price filters read `price_from`; rentals do not set it. They now read `rent_pw`.
  - `apps/console/.../auth/callback/route.ts` imported `@supabase/*` directly. Moved to
    `@repo/auth/callback`; no app imports Supabase any more.
  - AI page named "Bondi Prestige Group" and ranked it against invented competitors with
    invented market share. Gone; the page now says no market data is connected and carries
    a "preview only" banner.
  - Client bundle: `listing-form.tsx` imported the `@repo/core/listings` barrel, which
    reaches the database client — the production build failed on `Can't resolve 'fs'`.
    `ListingForEdit` moved to `listing-schema.ts`; the form imports the schema entry.
- Verified: typecheck 9/9 · lint 9/9 · tests 91/91 (72 before) · both apps build.
  Live DB: radius 1 km → 2 Bondi listings, 6 km → adds Paddington at 4.47 km, 6 km + 3 beds
  → 1. Same over HTTP on the running dev server. New console routes 307 to login when
  signed out.
- NOT done: `/login` "Register an Agency" was already fixed (STATUS.md was stale). The DB
  still holds 4 demo listings and one junk row — every delete from a script was refused by
  the sandbox, so they need the console's own Delete button or a permission rule.

### Later the same day — the key arrived
- It had been pasted into `.env.example`, which is the committed template. Moved to
  `.env.local` (gitignored) and the template blanked. Never committed, so nothing leaked —
  `git log -- .env.example` is empty and the file is still untracked.
- **Two generations of the Places API exist** and they are separate products in the Google
  console, listed as "Places API" and "Places API (New)". On this key: Geocoding OK, Places
  (legacy) OK, Places (New) 403 `SERVICE_DISABLED` — and the error names project
  `703563155093`, while the console screenshot showing "API Enabled" was project "QuoteMy AI".
  Likely a different project, not a propagation delay (still failing after ~15 minutes).
- Rather than make that a support problem, `provider-google.ts` now asks Places (New) first
  and falls back to the legacy autocomplete, and `resolve()` falls back to Geocoding by
  `place_id` — a different product, so it is usually on when Places is not. Verified live:
  suburb and street autocomplete both return results, and a picked suggestion resolves to
  full address components plus coordinates.
- **Resolved.** The console screenshot's OAuth client ids (`795078746989-…`) gave QuoteMy AI's
  project number, confirming the key was from a different project. A new key issued from
  QuoteMy AI, restricted to Places API (New) + Geocoding API, application restriction None.
  Verified: Places (New) OK, Geocoding OK, legacy now refused by the key's own restrictions —
  which is the intended result, not a regression. Address parts parse correctly including
  subpremise (`4/4 Hall St` → unit 4, number 4, Hall Street).
  The legacy fallback in `provider-google.ts` is no longer exercised. It stays: it is what
  makes the adapter work on a project with only the old Places API enabled, which is the
  ordinary mistake.
- `apps/*/.env.local` are **symlinks** to the root `.env.local`. Next's dev watcher does not
  see a change made through the symlink, so a dev server started before the key was added
  keeps running without it — which is why HTTP still showed the local fallback while a fresh
  process worked. Restart is the fix; nothing in the code.
- `packages/core/src/geo/backfill.ts` + `pnpm --filter @repo/core geo:backfill`. It lives in
  @repo/core, not @repo/db: it needs the geocoder, and core already depends on db — the other
  direction is a cycle. (`db:geocode` was added to @repo/db first and reverted for that reason.)
- All 5 demo properties re-geocoded from the hand-placed pins, which were up to ~600 m out.
- Verified with real coordinates: Bondi Junction 1 km → 0 results, 3 km → both Bondi Beach
  listings at 1.47 / 1.66 km, 6 km → adds Paddington at 3.32 km. Same over HTTP, and the
  distance label renders on the cards. This is the case suburb-name search could never serve:
  a buyer at Bondi Junction finding listings 1.5 km away in a different suburb.

## 2026-09-22 — Shell paints before the database answers

- Goal: two complaints — data refetching on every navigation, and no shimmer on a first visit.
- Found: `(agency)/layout.tsx` and `(agent)/layout.tsx` both `await requireConsoleAccess()`, which
  awaits `loadActorContext()` — a round trip to Seoul. The layout sits ABOVE the `loading.tsx`
  Suspense boundary, so the skeleton could not render until the query returned. The screen was
  blank for the whole trip, then shell + shimmer + content arrived together.
- Done:
  - `requireConsoleSession()` — headers only, no network. The layout uses it and paints at once.
  - `loadConsoleChrome()` returns a promise the layout does NOT await; `AgencyShell`/`AgentShell`
    read it with React 19 `use()` behind three Suspense boundaries (brand, profile role, ticker).
  - `AgencyGate`/`AgentGate` — server components inside Suspense that await `requireConsoleAccess()`.
    can() still decides and children still render only after it passes.
  - `loadActorContext` wrapped in `cache()` so the gate and the chrome share one query, not two.
  - `staleTimes.dynamic` 30 → 120 in console; added to web, which had no client cache at all.
  - `.shimmerLine` in both shell CSS modules, matching PageSkeleton's animation.
- Verified: typecheck clean, lint 9/9, 72 tests pass, console production build succeeds.
- NOT verified: the visual result. Confirming the shimmer needs a signed-in browser.
- Risks / watch: the gate's `redirect()` now fires after the shell has flushed, so the no-membership
  (`/get-started`) and wrong-surface (agent on the agency host) redirects became client-side
  navigations rather than HTTP 307s. They still work; test both paths in a browser.
- Dev server must be restarted for the `next.config.ts` staleTimes change to take effect.

# Session log

Newest entries on top. Keep roughly the last 10–15; archive older notes to `docs/memory/`.

## 2026-09-22 — Claude Code — Navigation latency measured and cut; optimistic state
- Goal: the console felt slow next to a plain React SPA. Find the actual cause instead of guessing
- Measured with a real session against the live DB, not by inspection. An **empty 10-line stub page**
  took 1537 ms before any of its own work:
  `middleware getUser 609ms` + `layout getUser 521ms` (the same answer, twice) + `loadActorContext 407ms`.
  React's own render was ~30 ms — state management was never the cause
- Fixed:
  - `requireConsoleAccess` now trusts the headers middleware already sets instead of calling getUser
    again. **Found a real hole doing it:** middleware set `x-console-user-id` only `if (user)` and never
    cleared it, so a client-supplied id would have survived for an anonymous request. It is now deleted
    first and set only after verification
  - Independent queries run together: `listAgencyAgents` and `listAgencyInvites` each did two sequential
    round trips (~190 ms apiece) over the same two tables
  - Agent names are sub-selected into the listings query instead of a follow-up keyed by listing id
  - `loading.tsx` on both console groups and on web — most of the "slow" feeling was a frozen screen,
    not the elapsed time
  - `useOptimistic` for publish/withdraw and `useTransition` for the listing form and invite resend
  - eslint now ignores `.next-*/**` (throwaway dist dirs were being linted: 2700 false findings)
  - Wizard defaults no longer pre-fill a Bondi Beach territory and a Prestige specialty on every agent
- Results (server time, same pages): `/settings` 671→478 ms, `/team` 1516→890 ms, `/live-listings`
  1490→850 ms. Production build: `/settings` 0.65 s, `/team` 1.05 s. The remaining ~650 ms is one
  getUser plus one query to Seoul — co-locating app and DB in Sydney takes that to ~250 ms
- Files: packages/auth/src/middleware.ts, apps/console/lib/{require-console-access,load-actor}.ts,
  packages/core/src/team/{list-agents,manage-invites}.ts, packages/core/src/listings/{list,search}-listings.ts,
  apps/console/components/{listing-table,listing-form,page-skeleton}.tsx,
  apps/console/app/{(agency),(agent)}/loading.tsx, apps/web/app/loading.tsx, packages/eslint-config/next.mjs
- Decisions: Next stays. A property portal needs SSR for SEO and server-side `can()`; a SPA would move
  authorization into the browser. The latency was network, and a SPA pays the same round trip to
  Supabase — it just shows a shell while it waits, which `loading.tsx` now does too
- Left unfinished (exact next step): consumer search results could be cached with `revalidate`; the
  remaining getUser in middleware is unavoidable without trusting the cookie unverified
- Risks / watch: `useOptimistic` reverts on transition end, so a failed publish silently returns the row
  to its real status — the error toast is what tells the user, and it must not be removed

## 2026-09-22 — Claude Code — Agents & Team made fully dynamic; migration 0004
- Goal: verify every field the 5-step onboarding wizard collects actually reaches the database and the
  screen, and remove the hardcoded mock data around it
- Found and fixed: `firstName` / `lastName` were never stored separately — only folded into `user.name`.
  Migration 0004 adds `agent_profile.first_name` / `last_name`; `materialiseAgent` writes them
- Done: `AgencyAgentRow` widened to the whole profile (bio, licence class/expiry, territory radius,
  languages, both commission splits, permission flags, public flag, joined date); the pending-invite
  branch fills the same shape from the wizard draft; team drawer became a grouped dossier with a
  60-day licence-expiry warning; stock avatar replaced by initials; agency name and header counts now
  come from SQL in the same query as the session; fabricated market ticker removed
- Files: packages/db/src/schema.ts + drizzle/0004_*.sql, packages/core/src/team/{invite-agent,list-agents}.ts,
  apps/console/lib/{load-actor,require-console-access}.ts,
  apps/console/app/{(agency)/{layout,agency-shell,team/team-directory}.tsx,(agent)/{layout,agent-shell}.tsx,(shared)/auth-shell.tsx},
  apps/*/package.json (dev → NEXT_DIST_DIR=.next-dev)
- Decisions: agency name reaches the chrome through the existing membership query rather than a second
  round trip; header counts are scalar sub-selects for the same reason; no fabricated figures anywhere
- Verified: live probe invited an agent with all 18 fields populated, read the directory while the invite
  was pending, claimed it, read again — every field present in both states; rows removed afterwards.
  typecheck 9/9, tests 72/72, lint 9/9, build 2/2
- Left unfinished (exact next step): `/login` copy still says "Agency OS" / "Register an Agency" on the
  agent host; `(agency)/ai/page.tsx` is still mock
- Risks / watch: no edit UI for an agent profile yet — the wizard is the only way in; photos still need R2

## 2026-09-22 — Claude Code — Invite flow finished; auth email links; listings end-to-end; pool reuse
- Goal: make the agent invite actually claimable, then let agencies and agents add listings that show
  on the consumer site, and stop the console feeling laggy
- Done:
  - Invite: middleware keeps `?invite=`; `/signup` splits live/expired/accepted/revoked; token survives
    into `/login`; claim links built from `NEXT_PUBLIC_AGENT_URL`; pending-invites panel with countdown,
    copy and resend (`listAgencyInvites`, `resendAgentInvite`, `peekAgentInvite`)
  - Auth email: added `(shared)/auth/callback` (PKCE `code` → session) and `(shared)/reset/update`.
    Neither existed, so every recovery link was a dead end
  - Listings: `packages/core/src/listings/*` (contract, create, list, search, publish) + `listing:create`;
    shared `ListingForm` / `ListingTable` on both console surfaces; `apps/web` home + `/search` + `/listing/[id]`
  - Perf: `getDb` pool memoisation; `loadActor` split from `loadListingActor`
  - `copyText()` helper — the old copy button reported success where `navigator.clipboard` is absent
- Files: packages/db/src/client.ts, packages/core/src/{permissions.ts,listings/*,team/{invite-agent,manage-invites}.ts},
  apps/console/{middleware.ts,lib/*,components/{listing-form,listing-table,toast}.tsx,app/(shared)/*,app/(agency)/*,app/(agent)/*},
  apps/web/{app/*,components/*,lib/db.ts}, apps/*/next.config.ts, docs/STATUS.md
- Decisions: listings always start as `draft` (#7); `price_display` and `price_from/to` both stored and the
  string never parsed (#6); property is reused when the address repeats (#1); one form component shared by
  both surfaces rather than one per route group
- Bugs found by our own tests/probes, not reported:
  - `setListingStatus` passed `actor.agencyId` as the resource, so `sameAgency()` compared the actor with
    itself and the check always passed — scoping was really the SQL `WHERE`, and refusals surfaced as
    "not found". Now the listing is read first and `can()` is asked about *its* agency
  - `resendAgentInvite` only checked invite status, so a lapsed row whose person had joined via another
    invite could be re-issued a live link. Membership is now checked too
  - `/auth/callback` first used `request.nextUrl.origin`, which reports the server's address, not the
    requested host — redirects left `agency.lvh.me` for `localhost`
- Verified: typecheck 9/9, tests 72/72, lint 9/9, build 2/2; live DB lifecycle (draft hidden → publish →
  searchable → property reuse) and live HTTP on both apps
- Left unfinished (exact next step): hardcoded "Bondi Prestige Group" / "Agency OS" labels should come from
  the DB and the host surface; then the agent desk beyond /listings
- Risks / watch: 4 demo listings are sitting in the live DB; no photos until R2 credentials exist; the two
  `getUser()` hops per navigation are the remaining latency and touching them has a header-spoofing nuance
- My own mistakes this session, for the record: twice broke the running dev server by starting a second one
  (and once `pnpm build`) against the same `.next`. `NEXT_DIST_DIR` now exists so it cannot recur

## 2026-09-21 — Claude Code — Admin vs agent roster; invite link made claimable
- Goal: Owner must not appear as an agent; Add Agent must produce a link the agent can actually use
- Done: `isAgencyAdminRole()` exported from permissions (role knowledge stays in one place);
  `AgencyAgentRow.isAgencyAdmin`; team directory splits an "Agency admins" strip from the sales roster
  and counts only agents in tabs/KPIs; dispatch no longer calls the auth provisioner
- Files: packages/core/src/{permissions.ts,index.ts,team/list-agents.ts},
  apps/console/app/(agency)/team/{team-directory.tsx,actions.ts,onboarding/dispatch/page.tsx}, docs/STATUS
- Decisions: wizard steps unchanged (user's call); owner/admin are team, not roster; no auth
  pre-provisioning on invite
- Verified against the live agency: Saad listed as admin with 0 agents → invite dispatched (pending) →
  real Supabase signUp from the claim link → claim activated membership → directory showed 1 admin +
  1 agent (Daniel Vance, Bondi Beach/Tamarama) → test rows removed, roster back to just Saad
- Left unfinished (exact next step): browser pass of Add Agent wizard on agency.lvh.me:3001/team
- Risks / watch: no revoke/resend/suspend actions yet; invite links are shared manually (no RESEND key)

## 2026-09-21 — Claude Code — Proper auth from scratch + demo wipe
- Goal: Delete demo data, build real auth entry path, keep Add-Agent wired to the DB
- Done: ADR 0006; `pnpm db:reset` guarded wipe script (auth.users untouched); migration 0003
  (unique index membership(user_id,agency_id), unique user.email); `packages/core/identity/ensureAppUser`
  mirrors auth.users → public.user; `packages/core/agency/registerAgency` writes agency+office+user+owner
  membership in one transaction with zod contract; `/get-started` page + form; `syncAccountAction` /
  `registerAgencyAction` read identity from the session; login/signup forms updated; membership + agent_profile
  writes in invite claim made idempotent; seed.ts rewritten to demo listings for an existing agency
- Files: docs/adr/0006, packages/db/{src/reset.ts,src/seed.ts,src/schema.ts,drizzle/0003_membership_unique.sql},
  packages/core/{identity,agency}/*, packages/core/src/team/invite-agent.ts, apps/console/lib/{auth-account.ts,
  require-console-access.ts}, apps/console/app/(shared)/{account-actions.ts,get-started/*,login,signup},
  apps/console/app/(agency)/team/actions.ts, apps/console/app/(agency)/live-listings/page.tsx, .env.example
- Decisions: self-serve agency registration (not invite-only); "Confirm email" off in dev; identity never
  accepted as a client argument; seed never invents users
- Security fix: `claimAgentInviteAction` took `userId`/`email` from the browser — any caller could mint a
  membership for another account. Removed; the claim now matches the session user's own email only.
- Left unfinished (exact next step): Turn off "Confirm email" in the Supabase dashboard, sign up at
  agency.lvh.me:3001/signup, register an agency, then run the Add Agent wizard and confirm the row lands in /team
- Build fix: `onboarding-state.tsx` and `review/page.tsx` (client) imported `TIER_SPLITS` from the
  `@repo/core/team` barrel, which re-exports db-backed functions — webpack pulled `postgres` into the
  browser bundle and `pnpm build` failed on fs/net/tls/perf_hooks. Added client-safe subpath
  `@repo/core/team/schema` (zod contract only) and rewired the three client imports. Build green.
- Risks / watch: 0001/0002 had no drizzle snapshots, so `db:generate` re-emits their statements — 0003 was
  hand-trimmed and its snapshot is now correct; team directory has no revoke/suspend actions yet;
  client components must import `@repo/core/team/schema`, never the `@repo/core/team` barrel

## 2026-09-21 — Cursor — DB migrate + seed
- Goal: Apply migrations and seed after password set
- Done: DIRECT_URL fixed to session pooler (db.*.supabase.co ENOTFOUND); migrate 0000–0002 OK; seed wrote org/listings with placeholder UUIDs (no auth users)
- Files: .env.local (DIRECT_URL), docs/STATUS
- Decisions: Use pooler :5432 as DIRECT_URL when direct host DNS fails
- Left unfinished (exact next step): Paste SUPABASE_SERVICE_ROLE_KEY then re-run db:seed for DemoPass123! auth users
- Risks / watch: Seed UUIDs won't match auth until service-role re-seed

## 2026-09-21 — Cursor — Agent add onboarding → database
- Goal: Wire Add Agent wizard with real backend storage (not Stitch mock)
- Done: Extended `agent_profile` (licence, territory, commission, permissions); new `agent_invite` table + migration `0002_agent_onboarding`; `@repo/core/team` inviteAgent/claimAgentInvite/listAgencyAgents + zod + can() tests; console server actions; wizard state (sessionStorage) across 5 steps; dispatch writes invite; team directory loads DB roster; signup/login claim invite; ADR 0005
- Files: packages/db/schema+drizzle/0002, packages/core/team/*, apps/console/team/**, signup/login, docs/adr/0005, STATUS|SESSION
- Decisions: Invite-first (JSONB draft); service-role optional provision; claim on signup/login when no service role; AuthZ only via can(team:manage)
- Left unfinished (exact next step): User must put real DB password + service role in .env.local, migrate + seed, then test `/team/onboarding` → `/team`
- Risks / watch: Without DATABASE_URL password, team page shows error banner and dispatch fails; principal signup still does not auto-create agency (separate flow)

## 2026-09-21 — Cursor — Wire real console authentication
- Goal: Turn off UI preview; enforce Supabase session + can() on console
- Done: `NEXT_PUBLIC_UI_PREVIEW=0` (.env.local + example); middleware protects private routes and bounces signed-in users off login/signup; login/signup/sign-out already on Supabase, reset now uses `resetPasswordForEmail`; agency/agent layouts call `requireConsoleAccess` (getUser + loadActor + can); removed Sarah Jenkins hardcoded profile; added `console:agency` / `console:agent` actions + tests; team + finance layouts gate via `team:manage` / `agency:billing`
- Files: .env.local, .env.example, apps/console/middleware.ts, lib/require-console-access.ts, (agency|agent)/layout + shells, (shared)/login|reset, (agency)/team|finance/layout, packages/core/permissions(+test), docs/STATUS|SESSION
- Decisions: Surface AuthZ via new can() actions (not raw role checks); React `cache()` on requireConsoleAccess for nested layouts; agents denied on agency host → redirect to NEXT_PUBLIC_AGENT_URL
- Left unfinished (exact next step): Replace YOUR_PASSWORD in DATABASE_URL, set SUPABASE_SERVICE_ROLE_KEY, run db seed, then sign in as seeded owner/agent
- Risks / watch: Without DB password, login succeeds then redirects to `/login?error=database`; signup creates auth user but not membership (can() will deny until invite/onboarding wires); restart `next dev` to pick up env

## 2026-09-20 — Cursor — Instant soft navigation (layout cache)
- Goal: Stop layout re-fetch / refresh feel on every sidebar tab
- Done: Removed `await headers()` from agency+agent layouts (static shell); middleware comment — single `updateSession` getUser only; native `<Link prefetch>` (dropped preventDefault/useTransition dim); agency `loading.tsx` is the pending fallback
- Files: apps/console/app/(agency)/layout.tsx, agency-shell.tsx, (agent)/layout.tsx, agent-shell.tsx, middleware.ts, docs/STATUS|SESSION
- Decisions: Profile label is static mock until auth wire; UI_PREVIEW banner from env only
- Left unfinished: Wire real user label without making layout dynamic (client profile chip later)
- Risks / watch: Restart `next dev` if layout still feels dynamic from old cache

## 2026-09-20 — Cursor — SPA-feel nav polish
- Goal: Reduce App Router click lag (preview + cache + pending UI)
- Done: UI_PREVIEW skips Supabase in middleware; `experimental.staleTimes` 30s dynamic; sidebar prefetch + useTransition push; top progress bar + content dim while pending
- Files: apps/console/middleware.ts, next.config.ts, agency-shell*, agent-shell*
- Note: Restart `next dev` so next.config staleTimes applies
- Left unfinished: Turn UI_PREVIEW off before real auth demos
- Risks / watch: staleTimes caches RSC payloads briefly — fine for UI mock

## 2026-09-20 — Cursor — Agent onboarding wizard (Stitch steps)
- Goal: Proper multi-step Add Agent flow from Stitch screens (hardcoded)
- Done: Shared WizardChrome 5-step; identity, territory+splits, permissions, executive review, digital pass/dispatch, governance board; Team CTA → /team/onboarding; all routes 200
- Flow: /team/onboarding → territory → permissions → review → dispatch (+ governance side path) → /team
- Files: apps/console/app/(agency)/team/onboarding/*
- Left unfinished: Wire real invite/auth later
- Risks / watch: none

## 2026-09-20 — Cursor — Team directory Stitch as-is
- Goal: Rebuild Agents & Team Performance Directory to match Stitch (hardcoded)
- Done: Full page — KPIs, tabs, 4-agent table, Daniel entity drawer, compliance banner; avatars in public/stitch/avatars; used cached HTML same screen id
- Files touched: apps/console/app/(agency)/team/*, agency-shell.module.css content:has full-bleed
- Left unfinished: Fresh fetch from project 11881435632227604948 blocked by key policy (same screen id used)
- Risks / watch: none

## 2026-09-20 — Cursor — Nav performance (middleware + loading + layout)
- Goal: Fix laggy App Router navigation in console
- Done: `updateSession` returns `{response,user}` (one getUser); console middleware no second call; agency `loading.tsx` skeleton; agency/agent layouts read `x-console-user-*` headers only (no getUser/loadActor)
- Files touched: packages/auth/src/middleware.ts, apps/console/middleware.ts, (agency)/layout+loading, (agent)/layout, docs/STATUS|SESSION
- Decisions: Auth gate stays in middleware; can()/DB checks deferred out of layout for UI-first speed
- Left unfinished: Optional skip Supabase entirely when UI_PREVIEW; prod build feel check
- Risks / watch: Page-level can() still needed before real admin actions

## 2026-09-20 — Cursor — Full agency Stitch screen set (UI mock)
- Goal: Download all Stitch Agency OS screens; implement remaining agency UI pages
- Done: 13 screens HTML+PNG in `apps/console/public/stitch`; pages for team, live-listings, ai, onboarding wizard (5 steps)+governance, password reset; nav wired; design-system stub not in list_screens
- Files touched: apps/console/app/(agency)/*, (shared)/reset, middleware, docs/STATUS|SESSION
- Decisions: Agency listings URL = `/live-listings` (avoid clash with agent `/listings`); confirm screens → review/dispatch/governance
- Left unfinished (exact next step): Visual polish / motion vs Stitch screenshots; then backend wire
- Risks / watch: UI_PREVIEW still on; Stitch key exposed historically — rotate

## 2026-09-20 — Cursor — Agency Overview home + surface shells
- Goal: Stitch Agency Overview as home; clear agency / agent / client UI division
- Done: `(agency)/overview` Command Centre; `AgencyShell` (sidebar+topbar); `AgentShell` (dark desk); middleware `/`→`/overview`; UI_PREVIEW bypass; surface-boundaries skill updated
- Files touched: apps/console/app/(agency)/*, (agent)/agent-shell*, middleware.ts, docs/STATUS|SESSION|architecture, .env.example, surface-boundaries skill
- Decisions: Three chrome shells; shared core only in packages/ui+core; agency home = /overview not /team
- Left unfinished (exact next step): Next agency Stitch screen (Team directory or Listings) under AgencyShell
- Risks / watch: Turn off NEXT_PUBLIC_UI_PREVIEW=1 before real auth demos; DB password still placeholder

## 2026-09-20 — Cursor — Build order → agency first
- Goal: Correct build order — agency UI before agent
- Done: STATUS/SESSION/README updated; Sign In treated as Agency OS surface
- Files touched: docs/STATUS.md, docs/SESSION.md, README.md
- Decisions: 1) Agency `(agency)` UI → 2) Agent `(agent)` UI → 3) Consumer web; UI-first per surface
- Left unfinished (exact next step): Next agency Stitch screen (Overview or Team directory) into `apps/console/app/(agency)/`
- Risks / watch: Don’t start agent listings UI until agency flow is satisfied

## 2026-09-20 — Cursor — Build order + Stitch MCP
- Goal: Lock UI-first build order; wire Google Stitch MCP locally
- Done: MCP stitch config; later corrected to agency-first
- Files touched: docs/STATUS.md, docs/SESSION.md, .cursor/mcp.json*, README.md
- Decisions: UI-first; Stitch for demos
- Left unfinished: agency screens
- Risks / watch: mcp.json gitignored; rotate exposed keys

## 2026-09-20 — Cursor — M0 foundation (schema + Supabase Auth)
- Goal: M0 — Drizzle schema, Supabase Auth, can(), seed, RLS
- Done: Auth pivot; schema; can()+tests; auth SSR; login middleware; migrations
- Files touched: packages/{db,core,auth,config}, apps/console, docs/*
- Decisions: Supabase Auth; Seoul=dev
- Left unfinished: migrate/seed needs DB password
- Risks / watch: DIRECT_URL + service role for seed

## 2026-09-20 — Cursor — Day-1 bootstrap complete
- Goal: Master Plan v2 Day-1 — docs, agent layer, bootable monorepo, host routing
- Done: Full tree; 8 skills; AGENTS/CLAUDE symlinks; packages stubs; web:3000 + console:3001 with agents/agency host surfaces; typecheck green
- Files touched: apps/*, packages/*, docs/*, AGENTS.md, .cursor/*, .agents/skills, root tooling
- Decisions: 3 domains / 2 apps; white-label assumed No for Day-1
- Left unfinished (exact next step): M0
- Risks / watch: white-label; region

## 2026-09-20 — Cursor — Day-1 bootstrap start
- Goal: Master Plan v2 Day-1 start
- Done: Started
- Files touched: docs/*, AGENTS.md
- Decisions: 3 domains / 2 apps
- Left unfinished: bootstrap
- Risks / watch: —
