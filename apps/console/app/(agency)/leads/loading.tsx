import { PageSkeleton } from '@/components/page-skeleton';

/**
 * The inbox's shape: a title, a subtitle, the tab row, and the table card.
 *
 * `PageSkeleton`'s three stat tiles stand in for the three tabs — they are the
 * same size and in the same place, so the skeleton and the page agree on
 * layout and nothing jumps when the rows arrive.
 *
 * Stated here rather than inherited from the route group, for the reason
 * live-listings gives: tuning it later should be a change to this file and not
 * to every console page at once. This route reads the database, and the
 * `every console route that reads the database has its own loading.tsx` check
 * in pnpm smoke is what noticed it was missing.
 */
export default function Loading() {
  return <PageSkeleton rows={1} />;
}
