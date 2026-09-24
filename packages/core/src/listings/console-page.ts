/**
 * How big a page of the console listings table is.
 *
 * Lives in packages/core rather than in either console page because both route
 * groups paginate the same book and a limit that disagrees between them makes
 * "page 3" mean two different things depending which surface you are on
 * (non-negotiable #10: if two route groups need it, it belongs here).
 */
export const CONSOLE_PAGE_SIZE = 25;

/** A 1-based page number from an untrusted query string. */
export function consolePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
