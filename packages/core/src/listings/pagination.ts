/**
 * Which page numbers to show under a paged search.
 *
 * It lives here rather than beside the component that renders it for two
 * reasons. It is pure arithmetic over a page count, which is the kind of thing
 * that belongs in packages/core by rule; and apps/web has no test runner, so a
 * copy of this in a `.tsx` file would be the one piece of off-by-one-prone
 * logic on the results page that nothing could hold to its edges.
 *
 * That matters because the edges are where this goes wrong. A window that
 * silently drops the last page is a page nobody can reach — the same class of
 * bug as the search that was capped at 48 rows with nothing after it, and
 * result 49 was simply unreachable on a portal whose whole job is showing what
 * is for sale.
 */

/** The marker for an elided run of pages, rendered as an ellipsis. */
export const PAGE_GAP = -1;

/**
 * How many numbers fit before eliding is worth it.
 *
 * Seven is first + last + the current page with one either side + two gaps,
 * which is the widest the elided form ever gets. Below that the elided form
 * would be longer than just listing them.
 */
const NO_ELISION_UP_TO = 7;

/**
 * 1 … 7 8 9 … 20, as a list with {@link PAGE_GAP} where the ellipses go.
 *
 * Previous/Next alone is correct and unusable on a twenty-page search —
 * reaching the end means twenty clicks and twenty renders. First and last are
 * always present, so the list says how much there is as well as where you are.
 *
 * Out-of-range input is clamped rather than rejected: `?page=999` on a 3-page
 * search already renders page 3's (empty) results, and a pager that threw
 * there would turn a harmless hand-edited URL into a 500.
 */
export function pageWindow(page: number, pages: number): number[] {
  const total = Math.max(1, Math.floor(pages));
  const current = Math.min(total, Math.max(1, Math.floor(page) || 1));

  if (total <= NO_ELISION_UP_TO) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const out: number[] = [1];
  const from = Math.max(2, current - 1);
  const to = Math.min(total - 1, current + 1);

  // A gap standing in for a single page is longer than the page it hides.
  if (from > 2) out.push(from === 3 ? 2 : PAGE_GAP);
  for (let n = from; n <= to; n += 1) out.push(n);
  if (to < total - 1) out.push(to === total - 2 ? total - 1 : PAGE_GAP);

  out.push(total);
  return out;
}
