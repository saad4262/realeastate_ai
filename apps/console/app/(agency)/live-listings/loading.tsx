import { PageSkeleton } from '@/components/page-skeleton';

/**
 * The listings table's shape: a title, a subtitle, the three count tiles and
 * the table card.
 *
 * That is what PageSkeleton draws, so this route is the one place the generic
 * shape is the right shape — and it is stated here rather than inherited from
 * the route group, so tuning it later is a change to this file and not to every
 * console page at once. `rows={1}` is one table card, not one table row.
 */
export default function Loading() {
  return <PageSkeleton rows={1} />;
}
