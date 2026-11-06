# ADR 0081: Open-home entry

**Status:** accepted 2026-11-06 (the user approved the mock, `docs/mocks/open-home-entry.html`, and migration 0091).

**Context.** The listing page, the `/inspections` planner, Agent AI and the console's property page all read `inspection`.
Nothing but a smoke test wrote to it, so buyers saw "No times scheduled" on every home and Inspection AI had nothing to plan.

**Decision.** A listing's Open homes tab and an `open_homes` import column, under `listing:edit`, with no owner approval: a
time on a public home is a fact the agent knows best. A time is typed in the property's time zone and shown in it everywhere.
Three kinds (Open home, By appointment, Auction); only Open home enters the planner. Repeating creates separate rows. Limits:
future, within 6 months, 10 minutes to 4 hours, no overlap on the listing, 20 upcoming, one upcoming auction; outside 7 am to
8 pm asks first. The rules are pure (`inspections/open-home-rules.ts`) so the form previews with them and the server enforces them.

**One truth for an auction.** `inspection` holds the time. `listing.auction_date` is kept equal to the next upcoming auction, in
the same transaction. A Details save no longer clears the date: that form has no such field, so it wrote null on every save.

**Fixed with it, invisible until now because there were no times.** The public card formatted times in the server's clock (UTC on
Vercel), and it showed times on homes no longer on the market.

**Not in this build.** The assistant adding times, the agent's calendar, an agency-wide weekend page, telling buyers about new or
removed times (plans live only in the link, so we do not know who chose a time), attendance sign-in.
