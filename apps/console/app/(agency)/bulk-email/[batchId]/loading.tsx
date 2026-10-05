import { PageSkeleton } from '@/components/page-skeleton';

/** The bulk email page's shape while the database answers. */
export default function Loading() {
  return <PageSkeleton rows={1} />;
}
