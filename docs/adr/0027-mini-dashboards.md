# 0027 — Mini dashboards

**Status:** ACCEPTED, 2026-10-06. Not built. This is ADR 0025's Phase F ("widgets hook"), made concrete. Decisions at the end ("Decided").

**Context.** An admin asks the assistant "last 7 days Sold value" and wants a link that opens
a screen that stays up to date — something to leave open on an office TV or send to a
partner in the agency. The platform rules still hold: numbers come from SQL, never from the
model (#4); the server is the only door to the database (0017); nothing generated runs.

## Decision

1. **A fixed widget library, in code.** `packages/core/src/widgets/registry.ts`: each widget
   is `{ id, title, params (zod), permission (an Action), query(db, actor, params) → typed
   rows, refreshSeconds }`, and each has one fixed React component in `packages/ui`. The model
   never writes code, SQL, a chart spec or a number; it can only choose a widget id and
   parameters that the zod schema accepts. A new kind of widget is a code change, reviewed.
2. **"Sold value", not "Revenue".** Until the client says where revenue/commission really
   comes from, the money widget is named **Sold value**: `sum(listing.sold_price)` over the
   agency's own listings with `status = 'sold'` and `sold_date` in the range, in the agency's
   time zone. Sold listings with no `sold_price` (undisclosed) are **counted and shown
   separately** ("3 sold without a disclosed price"), never treated as zero. The words
   "revenue" and "commission" appear nowhere until that source exists (open question 1).
3. **A dashboard is a saved list of widgets.** Table `dashboard`: id, agency_id, created_by,
   title, `widgets` (jsonb: `[{ widget, params }]`, re-parsed by the registry on every read),
   `audience` (`private` | `admins` | `agency`), created_at, updated_at, archived_at. Additive
   migration, RLS on, no grants.
4. **Its URL** is `https://agency.<domain>/dashboards/<id>` (and `agents.<domain>/…` for one
   shared with the whole agency). Opening it needs a **signed-in session, an active
   membership in the same agency, and `dashboard:read`** — see Permissions. A dashboard id is
   a UUID, but the URL is not the key: a guessed or forwarded link opens nothing for anyone
   who could not open it anyway.
5. **No public links in v1.** A link cannot be shared with someone outside the agency. If the
   client needs that (a franchise owner, an investor), it becomes a separate, explicit,
   revocable "share link" feature with its own ADR: a signed token, an expiry, a read-only
   snapshot and an audit of who opened it (open question 2).
6. **Each widget's numbers are computed AS THE VIEWER**, not as the creator. An agent opening
   an "agency"-audience dashboard sees each widget at their own scope — or a "You don't have
   access to this figure" tile when the widget's permission refuses them. A dashboard can
   never widen what its viewer may see.
7. **Live updates by polling the server**, not a browser database subscription (ADR 0017
   forbids browser table access; a websocket service would be a second door). The page calls
   `GET /api/dashboards/<id>/data` every `refreshSeconds` (the shortest of its widgets', at
   least 30 s; "last 7 days" style widgets 60 s), with `If-None-Match`: the server returns
   304 when the figures' hash is unchanged. It pauses while the tab is hidden
   (`visibilitychange`) and shows "Updated 12:04 pm". Each request is one query per widget at
   most, cached per (agency, widget, params, viewer scope) for 15 s on the server so ten open
   TVs cost one query (open question 3). Server-Sent Events are the later upgrade if 30 s is
   not live enough.
8. **The assistant creates one as a proposed action** (ADR 0025's flow, unchanged):
   - a read tool `show_widget({ widget, params })` puts the widget inline in the chat (no
     card — it only reads), returning to the model **only** "widget shown", never the figures
     (so it cannot restate or compute one);
   - a write tool `create_dashboard({ title, widgets: [{widget, params}], audience })`
     **proposes**: the card shows the title, each widget with its plain-words range ("Sold
     value — last 7 days, Melbourne time"), who will be able to open it, and a live preview of
     the figures rendered from SQL. **Approve** creates the row (re-checking
     `dashboard:create` and each widget's permission as the approver) and the card then
     shows the URL with Copy and Open. Same idempotency, audit (`activity` has no contact here,
     so the audit is the `proposed_action` row plus `ai_run`) and expiry as every card.

## First widget list

All read through the existing scope helpers; every figure is SQL; ranges are `today`,
`7d`, `30d`, `90d`, `this_month`, `last_month`, `this_year` in the agency's zone.

| Widget | What it shows | Permission |
|---|---|---|
| `sold_value` | Sum of `sold_price`, count sold, count sold without a price | `report:read_agency` (owner/admin) |
| `sold_count` | Listings sold in the range, by agent | `report:read_agency` |
| `listings_by_status` | Live / under offer / sold / withdrawn now | `listing:read` scope (agent: their own) |
| `new_leads` | Enquiries received, by day, never offers for non-admins | `lead:read` scope |
| `leads_by_source` | Enquiries by source | `lead:read` scope |
| `upcoming_appointments` | Next 7 days, by type | `appointment:read` scope |
| `days_on_market` | Median days from `published_at` to `sold_date` for sales in the range (SQL `percentile_cont`) | `report:read_agency` |
| `template_emails_sent` | Sent / skipped by reason (ADR 0022) | `email_batch:read` scope |

## Permissions (all through `can()`)

- `dashboard:create` — owner/admin in v1 (agents can ask for `show_widget` inline but not
  save dashboards; open question 4).
- `dashboard:read` — `private`: its creator; `admins`: any owner/admin of the agency;
  `agency`: any active member of the agency. Always same agency.
- `dashboard:manage` (rename, change audience, archive) — its creator or an admin.
- `report:read_agency` — new: agency-wide money and performance figures. Owner/admin.
- Each widget's own `permission`, checked per viewer per request.

## When something is not connected

Nothing in the first widget list depends on an integration. A future widget that does (e.g.
Google review rating, ADR 0028) shows its own "Connect Google Reviews first" tile with the
Integrations link for an admin, "Not set up by your agency yet" for others; the rest of the
dashboard still renders. The assistant's `create_dashboard` card lists such a widget with the
same note rather than refusing the whole dashboard.

## Failure cases

| Case | What happens |
|---|---|
| A widget id or params the registry no longer knows (code changed) | That tile says "This widget is no longer available"; the rest render. |
| Viewer loses access (membership suspended) | Next poll returns 404; the page says "You no longer have access" and stops polling. |
| Creator leaves the agency | Dashboard stays (it belongs to the agency); `created_by` set null; admins can manage it (ADR 0030 offboarding). |
| A sold listing is un-sold / price corrected | Next poll shows the new figure; no stored totals to drift. |
| Very large agency, slow query | Each widget query has a 3 s statement timeout; that tile shows "Taking too long — try a shorter range". |
| Ten screens open | Server-side 15 s cache; 304s when unchanged. |
| The model asks for a widget that does not exist | Schema refuses; it is told the list. |

## Tests to write

- Unit: every registry entry has params schema, permission, refresh ≥ 30 s; unknown widget
  ids refused; `sold_value` treats null `sold_price` as "undisclosed", never 0 (fixture with
  three sold listings, one without price); the model's tool result never contains a number.
- Query-count: each widget is one statement (three-row fake db).
- Smoke (rolled back): agency A's `sold_value` equals a hand-written SQL sum over A's sold
  listings in range and never includes B's; an agent opening an `agency` dashboard gets the
  "no access" tile for `sold_value`; `private` dashboard 404s for another admin; a link opened
  by a member of agency B 404s; 304 when unchanged; `create_dashboard` card → approve → row,
  double approve → one row.
- Permission tests for `dashboard:*` and `report:read_agency`.
- **Break-tests:** compute as the creator instead of the viewer → red; drop the agency filter
  in `sold_value` → red; count null price as 0 → red; skip `dashboard:read` → red.

## Open questions (recommended answer first)

1. **Where does real revenue/commission come from?** — *Keep "Sold value" until the client
   names the source* (commission rates per listing, an accounting export, or their CRM).
2. **Share a dashboard with someone outside the agency?** — *Not in v1*; if needed, a separate
   signed, expiring, revocable share link with its own ADR.
3. **How live is live enough?** — *30–60 s polling with 304s*; SSE only if the client asks.
4. **May agents save their own dashboards?** — *Not in v1*; they can ask for inline widgets.
5. **Agency time zone** — *add `agency.time_zone` (default Australia/Sydney)* so "this month"
   means the same for everyone looking at one screen.
6. **First widget list** — *the eight above*; the client picks which three matter most for the
   first release.

## Decided (2026-10-06)

- **Q1 (client): revenue = Sold value.** `sum(listing.sold_price)` of the agency's own sold
  listings with `sold_date` in the range; sold listings without a disclosed price are counted
  and shown separately, **never as zero**. No other revenue/commission source. Closed.
- **Q2 (client): signed-in members of the same agency only.** No share link for anyone outside,
  now or as a planned feature.
- **Q4 (the user): only admins save dashboards** (`dashboard:create` owner/admin). Agents can
  see inline widgets in the assistant.
- **Q6 (client): the first widgets**, mapped to the list above:

  | Client's widget | Widget |
  |---|---|
  | Sold value | `sold_value` |
  | Number of sales | `sold_count` |
  | New leads | `new_leads` |
  | Appointments this week | `upcoming_appointments` (range `this_week`, Monday–Sunday in the agency's zone) |
  | Active listings | `listings_by_status`, shown as one "Active" figure = live + under offer, with the split underneath |
  | Email replies | **new widget `email_replies`** — messages received (`mail_message.direction = 'in'`) in the range on threads the viewer may read (`threadScopeFilters`), from SQL. It was not in the list of eight. |

  **Left for later:** `leads_by_source`, `days_on_market` and `template_emails_sent`. That is
  three rather than two, because "email replies" is a new widget rather than one of the eight.
- Q3, Q5: **accepted as recommended** (30–60 s polling with 304s; add `agency.time_zone`,
  default Australia/Sydney, which also defines "this week").
