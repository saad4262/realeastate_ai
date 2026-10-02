import { PageSkeleton } from '@/components/page-skeleton';

/**
 * The same shape as the agency inbox it shares a table with: title, subtitle,
 * the tab row (stood in for by the stat tiles) and the table card.
 */
export default function Loading() {
  return <PageSkeleton rows={1} />;
}
