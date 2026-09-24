# Test plan

Three layers, in the order you should reach for them.

| Layer | Command | Covers | Needs |
|---|---|---|---|
| Unit | `pnpm test` | permissions, contracts, query shape, **atomicity, query counts** | nothing |
| Smoke | `pnpm smoke` | migrations, **indexes, partial writes, caching, speed**, Google, HTTP, fail-closed | dev servers + DB |
| Manual | this document | anything behind a login | a browser |

## What guards the performance work

These exist because none of it is visible when it breaks. An N+1 returns the
right answer; a lost cache is merely slower; a non-transactional write only
shows up on the failure path nobody exercises.

| Guard | Where | Catches |
|---|---|---|
| `atomicity.test.ts` | unit | a write escaping its transaction — asserts `OUTSIDE:` never appears |
| `query-count.test.ts` | unit | an N+1. Every read has an exact query count, measured not guessed |
| every index is present | smoke | a migration that dropped one; radius search silently scanning |
| no listing without an agent | smoke | a partial write that actually reached the database |
| no membership without a profile | smoke | the same, on the team side |
| cold vs warm ratio | smoke | caching removed or misconfigured |
| cache cleared from outside | smoke | the console losing its ability to publish to the public site |

**Each was verified by breaking the thing it guards**, not by being written and
assumed. The query-count test failed that bar first time round: it returned no
rows, so a deliberately added per-row query went unnoticed. It returns three
rows now — a fake that returns nothing cannot catch a bug that costs one query
per row.

`pnpm test` is the one that says the code is wrong. `pnpm smoke` runs against the live
database, the live Google account and whatever dev servers are up, so a failure there is
often something outside the code — read the detail line before touching anything.

---

## Before a manual pass

```bash
pnpm test && pnpm smoke
```

If either is red, stop. Manual testing on top of a broken base wastes an hour and teaches
you nothing.

---

## Manual cases

Every case below needs a signed-in browser, which no script here can produce. Work through
them in order — later cases depend on data earlier ones create.

Hosts (from `.env.local`):

- consumer `http://web.lvh.me:3000`
- agency `http://agency.lvh.me:3001`
- agent `http://agents.lvh.me:3001`

### A. Getting in

| # | Do this | Expect |
|---|---|---|
| A1 | Open the agency host signed out | Redirected to `/login`, not a blank page |
| A2 | `/signup` on the agency host, register an agency | Lands on `/overview`, sidebar names **your** agency, not a placeholder |
| A3 | `/signup` on the **agent** host with no invite | Says agents join by invitation. **No "Register an Agency" link** |
| A4 | Sign in on the agency host, then open the agent host | Still signed in — one cookie across both (`COOKIE_DOMAIN`) |
| A5 | Sign out, then open a `/live-listings/<id>/edit` URL directly | Redirected to login. Never renders the form first |

### B. Inviting an agent

| # | Do this | Expect |
|---|---|---|
| B1 | Agents & Team → Add Agent, walk all six steps | Each step keeps what you typed when you go back |
| B2 | On **Territory**, type `bond` in Add suburb | Dropdown: Bondi Beach, Bondi Junction, Bondi… |
| B3 | Pick one | Becomes a chip. Picking it twice does not duplicate it |
| B4 | Type a suburb that does not exist and press Add | Still accepted — free text is allowed on purpose |
| B5 | Finish the wizard | A claim link with a live countdown. Copy button works on plain HTTP |
| B6 | Wait for the link to lapse | Panel offers a new link rather than extending the old one |
| B7 | Open the claim link in a private window, set a password | Agent lands on the agent desk, not the agency console |
| B8 | Open the **same** link again | Says already accepted — not "expired" |

> B5 is where the flow breaks today: `RESEND_API_KEY` is unset, so no email is sent. The
> link has to be copied and passed on by hand.

### C. Creating a listing

| # | Do this | Expect |
|---|---|---|
| C1 | Agent desk → Add listing. Type `12 campbell parade bondi` in **Find the address** | Suggestions appear after ~3 characters |
| C2 | Pick one | Unit / street number / street / suburb / state / postcode all fill. Hint reads **Pinned** |
| C3 | Change the street number by hand | Hint stops saying pinned — the old pin no longer matches |
| C4 | Clear the form, type `Pakenham` in **Suburb** and pick it | Suburb, state and postcode fill together. Hint reads `Pakenham, VIC 3810` |
| C5 | Type a suburb by hand and save | Saves. The server geocodes it afterwards |
| C6 | Save with the suburb blank | Field goes red before any request is sent |
| C7 | Save a sale listing with **Search to** below **Search from** | Rejected, with the message on `priceTo` |
| C8 | Switch to **For rent** and save with no weekly rent | Rejected — rent is required for a rental |
| C9 | Save successfully | Toast says **draft**. Row appears with a Draft badge |
| C10 | Open the consumer site and search for it | Not there. Drafts are private |

### C2. The map pin (needs `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`)

Suburb and pin are two different things. These cases are about the pin.

| # | Do this | Expect |
|---|---|---|
| CM1 | Open Add listing with **no** browser key set | A short "Map not configured" panel. Not a grey box, not a crash. The rest of the form works |
| CM2 | With the key set, pick a full address, then open **Check or move the pin** | Satellite map, marker on the property, status says *Found from the address* |
| CM3 | Drag the marker two streets away | Status flips to **Placed by hand**. Coordinates under the map update |
| CM4 | Click anywhere on the map | The marker jumps there. Same as dragging |
| CM5 | After dragging, change the street number | The pin **stays**. A hand-placed pin survives an address edit |
| CM6 | Save, reopen the listing for editing | Still *Placed by hand*, still in the same spot |
| CM7 | On an edit with a hand-placed pin, click **Put it back where the address says** | Returns to the geocoder's pin |
| CM8 | Pick only a suburb, no street, and save | No pin. Status says the listing will not appear in distance searches |
| CM9 | Run `pnpm --filter @repo/core geo:backfill` | The hand-placed pin is **not** touched. Only `--redo` moves it |

### D. Editing and deleting

| # | Do this | Expect |
|---|---|---|
| D1 | Edit a **live** listing, change the headline, save | Toast says the status is unchanged. Badge still Live |
| D2 | Edit a listing and change its suburb entirely | Saves. The old property row still exists (its history is not rewritten) |
| D3 | As an **agent**, look at the listings table | **No Delete button.** Edit is there |
| D4 | As the **owner**, click Delete on a draft | Asks to confirm. Second click removes the row |
| D5 | As the owner, click Delete on a **live** listing | Refused: withdraw it first |
| D6 | Withdraw it, then Delete | Works |
| D7 | Delete a listing, then check the property still exists | The address survives its ad. Only the listing is gone |

### E. Publishing

| # | Do this | Expect |
|---|---|---|
| E1 | Publish a draft | Badge flips to Live **immediately**, before the server answers |
| E2 | Publish with the network throttled to offline | Badge reverts on its own and an error toast appears. It must not silently stay Live |
| E3 | Publish, then open the consumer site | The listing is there |
| E4 | Withdraw it, reload the consumer site | Gone |

### F. Consumer search

| # | Do this | Expect |
|---|---|---|
| F1 | Type `pakenham` in the search box | Suggestions: Pakenham, Pakenham Upper, Pakenham South |
| F2 | Pick Pakenham | A second row appears: **`Pakenham, VIC 3810 only`** |
| F3 | Search with that default | Only listings in Pakenham. Nothing from neighbouring suburbs |
| F4 | Change to **`+ within 10 km`** and search again | Pakenham's listings are **all still there**, plus nearby ones. The count never drops |
| F5 | Check the heading | Reads "in Pakenham VIC 3810 **and** within 10 km of it" |
| F6 | Look at a result from a neighbouring suburb | Shows "x.x km away" |
| F7 | Type free text and press Search without picking | Text search across suburb, street, headline and postcode |
| F8 | Add beds / baths / price filters on top of a radius | They narrow the results; the radius still applies |
| F9 | Switch Buy → Rent | Price options change to weekly amounts, and the previous cap is cleared |
| F10 | Copy the URL into a new tab | Identical results. Everything is in the URL |
| F11 | Click **Clear location** | Back to a plain text search |
| F11a | Search a suburb with **no** radius, then on the results page pick **+ within 10 km** and search again | The count changes. This silently did nothing once: the first search put no lat/lng in the URL, so the radius was dropped on the second |
| F11b | Check the URL after picking a suburb from the dropdown | It carries `suburb`, `state`, `postcode` and — because the picker already resolved them — `lat`/`lng`. The **radius** is what has to be there; the centre is re-resolved server-side either way (`searchQueryToParams` omits the coordinates entirely for this reason) |
| F11c | Run a search, publish a matching listing in the console, then re-run the **same** search in a tab that already ran it | It appears within 30 s at worst, and usually at once. The router cache window is derived from `cachedSearch`'s TTL, so it can never be the staler of the two. In a **fresh** tab it is immediate — `revalidateTag` cleared the data cache on publish |
| F11d | Search a suburb with a **small** radius, where the suburb is wider than it | Cards in that suburb say **"In Pakenham"**, not a distance. Only results the radius brought in show "x.x km away" |
| F11e | Read the heading on any suburb-plus-radius search | It names both halves — "2 in Pakenham, and 1 more within 10 km" — never just a total |
| F11f | Click Search with results already on screen | The page does **not** blank. The old results stay, a progress line appears under the search card, the button reads "Searching…" |
| F11g | Click a listing card from the results | A skeleton in the shape of the page — hero block, address bar, price, fact grid — appearing **immediately**, not the word "Loading" and not a blank screen |
| F11h | Hover a listing card for a moment, then open DevTools → Network (`_rsc`) | One prefetch fires ~100 ms after the pointer settles. Sweeping the pointer quickly across the whole grid fires **nothing** — that delay is the difference between intent and a mouse passing by |
| F11i | Open a listing, then press Back | The results are there instantly, with no network request for the page. Before this the whole search re-rendered server-side on every Back |
| F12 | With results on screen, click **Show N on a map** | A map with a marker per pinned result, framed to fit them all |
| F13 | Click a marker | Info window with the address, linking to that listing |
| F14 | Search where some results have no pin | The map says how many are missing rather than hiding them silently |
| F15 | Open a listing that has a pin | Map under the headline, centred on the property |
| F16 | Open a listing with **no** pin | No map at all — not a map centred on the suburb |
| F17 | Open `/search?suburb=Pakenham` (no `lat`/`lng`), then pick a radius and search | Results widen. The URL gains `radius=` **without** gaining coordinates, and the server resolves the centre. This is the case that regressed once as "the dropdown said + within 10 km and nothing moved" |
| F18 | Pick a **street address** from the dropdown, then search | The URL carries `lat`/`lng` — an address has no suburb for the server to look up, so the coordinates are the only centre there is |
| F19 | DevTools → Network while submitting a suburb search | No request to `/api/places` on submit. The centre is the server's job; asking for it here was a round trip whose answer the next render discarded |
| F20 | **The desync.** Search "Pakenham, 3 beds". Then search "Bondi, 2 beds". Then press **Back** | The box goes back to Pakenham and 3 beds, matching the results behind it. This is the bug the GET form exists to make impossible: the fields used to be mirrored into state that was read from the URL once and never again, so Back moved the results and left the box saying Bondi — and the next submit sent Bondi |
| F21 | **No JavaScript.** Disable JS in DevTools, open `/search`, type a suburb name, pick beds and a price, press Search | It searches. The form is `action="/search" method="get"` with named fields, so the browser builds the same URL the server parses. Every field arrives, empty ones included, and the server drops those. What does NOT work without JS is the suburb typeahead and the radius that depends on it — a keyword search is the fallback |
| F22 | Set a maximum price, then switch Buy → Rent | The price selects reset. Sale prices and weekly rents are different orders of magnitude, so a bound carried across reads as "no results anywhere". Arriving on a `channel=rent` link shows weekly rents server-rendered, with no JavaScript needed |
| F23 | Pick a suburb, choose "+ within 10 km", read the sentence beside the dropdown | It says "Pakenham, VIC 3810 plus anything within 10 km of it" and updates as the dropdown changes — the select is uncontrolled, but the sentence echoes it |

### G. Navigation and feel

| # | Do this | Expect |
|---|---|---|
| G1 | Sign in and click between Team and Listings | Sidebar and shell paint **immediately**; a shimmer fills where the data is coming |
| G2 | Click Team → Listings → Team within two minutes | The second visit to Team does not refetch |
| G3 | Publish a listing, then navigate away and back | Your own change is visible at once — mutations clear the cache |
| G4 | Sign in as a user with no agency | Sent to `/get-started` |
| G5 | Sign in as a plain agent and open the **agency** host | Bounced to the agent desk |
| G6 | DevTools → Network, filter `_rsc`, then load any console page | A handful of prefetches as links enter the viewport — **not** twelve full page renders the moment the shell mounts. Both mechanisms used to run at once |
| G7 | Click a sidebar item | The skeleton appears at once, then the page. Prefetch now stops at `loading.tsx`, which is what makes the skeleton instant |
| G8 | Throw inside a console page body, then load it | The **sidebar and header stay**; only the content area shows "This page didn't load". A full-page error would lose your place |
| G9 | Sign out, then open `/live-listings` directly | Still `307 → /login`. Adding `error.tsx` must never swallow the redirect `requireConsoleAccess` throws — `pnpm smoke` asserts this too |
| G10 | Open `/listing/<id-that-does-not-exist>` on the consumer site | A 404 **inside the site's own header**, offering the search — not Next's unstyled default page |
| G11 | **The header strip.** Start a throwaway console: `cd apps/console && NEXT_PUBLIC_UI_PREVIEW=1 NEXT_DIST_DIR=.next-preview npx next dev --port 3002`. Take a real active `membership.user_id` from the database, then `curl -i -H "x-console-user-id: <that id>" http://agency.lvh.me:3002/live-listings` | **307 to /login.** Anything else is impersonation: server actions now trust this header, so a 200 here means a forged header can publish, edit and delete that agency's listings. Preview mode is the one path where middleware returns before authenticating, so the strip is the only thing standing there. Verified failing (HTTP 200, rendering the owner's console) with the strip removed, and passing with it |

> G4 and G5 are client-side redirects since the shell now flushes before the permission
> gate resolves. They work, but they are the two paths most likely to regress.

### H. The property guide (`/chat`)

Needs `ANTHROPIC_API_KEY`. Without it the page still renders and the composer answers
with "not available right now" — check that first, because it is the state a fresh
clone is in.

| # | Do this | Expect |
|---|---|---|
| H1 | Open `/chat` | The site's own header, then a conversation card on the left and an empty results panel on the right. Cream and forest green — no sapphire anywhere |
| H2 | Type "I need a house in Pakenham" and send | It **asks a question** — budget, or bedrooms. The results panel stays empty |
| H3 | Answer "under 800k, 3 beds" | Results fill the panel. The chips read exactly `For sale · Pakenham · 3+ bed · under $800,000` |
| H4 | Compare one card's price against its own listing page | **Identical.** Any difference is a #4 violation and a stop-ship |
| H5 | Say "within 30 km of Pakenham" | The panel's "Open these in search →" link carries `suburb=Pakenham&radius=30` and **no** `lat=` |
| H6 | Follow that link | `/search` shows a consistent count — at least as many as the chat displayed |
| H7 | Ask "tell me about the second one" | It answers with a price. Watch the server log: it calls `get_listing` rather than recalling. It cannot recall — earlier turns carry no tool results |
| H8 | Ask for something the portal has nothing of | It says so plainly and offers to relax one filter. It does not invent a listing |
| H9 | Open DevTools → Network → the `/api/chat` request | The response pane grows **line by line**. If the whole body lands at once, something is buffering — check `content-encoding` |
| H10 | Repeat H9 after `pnpm --filter @repo/web build && pnpm --filter @repo/web start` | Same. Dev and production differ on compression, and only one of them is what ships |
| H11 | Close the tab mid-answer, then `select * from ai_run order by created_at desc limit 2` | The rows are there. Tokens spent on an abandoned turn were still spent |
| H12 | Three turns, then check the server log for `cache_read_input_tokens` | Greater than zero on turns 2 and 3. Zero means the prompt prefix is being rebuilt per request |
| H13 | At 375 px wide | Chat/Results tabs appear and switch. The keyboard does not cover the composer. The thread scrolls independently of the page |
| H14 | Send a message, then click **Stop** | Text stops arriving, the button returns to Send, and no empty bubble is left behind |
| H15 | Paste a listing description containing "ignore previous instructions" into the console, publish, then ask the guide about that suburb | The instruction has no effect. Search results carry no description at all; `get_listing` fences it |

> H4 and H12 are the two that matter most. H4 is the only manual check that can catch a
> hallucinated price; H12 is the only way to notice the caching has silently stopped
> working, which shows up as a bill rather than a bug.

---

## Starting from empty

`pnpm --filter @repo/db db:clear-listings` shows what would go; `--confirm` deletes it.
Listings and any property rows left with nothing pointing at them — never agencies,
memberships or users, because the agency holds the only owner login.

With no listings, the search group in `pnpm smoke` skips rather than fails. That is
deliberate: an empty database is a legitimate state, and a red run for it would teach
everyone to ignore the output. The skips say so in the output, so the gap stays visible.

## What no test here covers

- **Photos.** `media` is empty and there is no upload path (`packages/media` does not exist).
- **Leads.** No enquiry form, so nothing ever writes to `lead`. The Leads pages are mocks.
- **AI beyond the consumer chat.** `/chat` is built and covered above and in `pnpm smoke`.
  Nothing else calls a model: no listing-copy drafting, no lead summarising, and the
  agency console's `(agency)/ai` page is still a labelled mock.
- **Chat abuse.** Nothing is persisted, so there is no transcript to review if the guide
  says something it should not — only an `ai_run` row with token counts.
- **Email.** No `RESEND_API_KEY`, so no invite, recovery or confirmation mail is actually sent.

When any of those is built, add its cases here and its invariants to `pnpm smoke`.

## Adding to the smoke test

`packages/smoke/src/index.ts`. A check should assert an **invariant**, not a row count —
the database changes between runs, and a check that hardcodes "3 results" is a check that
will be deleted the first time somebody adds a listing.

Prefer relationships that must hold whatever the data is:

```ts
// good: true on any database
assert(withRadius.length >= exact.length, 'a wider search returned fewer results');

// bad: true only today
assert(rows.length === 3, 'expected 3 results');
```

Before trusting a new check, break the thing it guards and confirm it goes red. A check that
has never failed has never been shown to work.
