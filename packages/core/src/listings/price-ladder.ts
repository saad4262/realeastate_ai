/**
 * A price ladder that spans what is actually listed.
 *
 * ## Why this is its own file
 *
 * `search-bar.tsx` is a client component and it needs this function. Its
 * neighbour `search-facets.ts` runs the query, so it imports `listing` and
 * `property` from @repo/db as VALUES — and @repo/db imports postgres.js, which
 * imports `net`. Importing this from there broke the entire web app with
 * "Module not found: Can't resolve 'net'": every page 500ed, eighteen smoke
 * checks went red at once, and the cause was one import in one client file.
 *
 * listing-card.tsx carries the same warning at the top for the same reason.
 * Pure functions a client can need live in leaves with no database import;
 * `search-facets.ts` re-exports this so server callers still have one place to
 * look.
 */
export function priceLadder(
  min: number | null,
  max: number | null,
  steps = 6,
): number[] {
  if (min === null || max === null || !(max > min)) return [];

  const nice = [
    1, 5, 10, 25, 50, 100, 250, 500,
    1_000, 2_500, 5_000, 10_000, 25_000, 50_000,
    100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000,
  ];

  const span = max - min;
  const rough = span / (steps + 1);
  const step = nice.find((n) => n >= rough) ?? nice[nice.length - 1] ?? 1;

  const out: number[] = [];
  // Start at the first step boundary strictly above the minimum, so the
  // cheapest rung already excludes something.
  for (let v = Math.ceil(min / step) * step; v < max && out.length < steps; v += step) {
    if (v > min) out.push(v);
  }

  // A range narrower than one step produces nothing above. One rung in the
  // middle is still more useful than an empty dropdown.
  if (out.length === 0) {
    const mid = Math.round((min + max) / 2);
    if (mid > min && mid < max) out.push(mid);
  }

  return out;
}
