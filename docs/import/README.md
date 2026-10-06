# Listing import template (ADR 0029)

`listings-template.csv` is the file format for the bulk listing import. The client asked us to
define it to match how a listing is created in the console today. Every column, whether it is
required, and where it goes are in **ADR 0029 → Decided → "The CSV template"**.

The three example rows (all fictional — `example.com` addresses):

1. **`AG-1001`** — a house **for sale, live**, with a display price AND a searchable range
   (both are stored, non-negotiable #6), an auction time, two agents (first is lead) and three
   photo links in display order.
2. **`AG-1002`** — a **unit for rent, live** (`2/6E Main Street`): weekly rent, available-from
   date, no sale price, two agents `;`-separated.
3. **`AG-0874`** — **sold history**: status `sold` with `sold_price` and `sold_date` (both
   required for a sale), no photos.

Rules a file must follow: UTF-8, comma-separated, a header row, dates `YYYY-MM-DD`
(auction `YYYY-MM-DD HH:mm` in the agency's time zone), money in whole dollars without `$` or
commas in the number columns, text with commas in double quotes, photos separated by `|`.
Column order does not matter (the mapping screen matches by header); extra columns are ignored.
