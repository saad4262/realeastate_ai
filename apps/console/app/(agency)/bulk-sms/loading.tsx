import { PageSkeleton } from '@/components/page-skeleton';

/** The Bulk SMS page's shape while the database answers. */
export default function Loading() {
  return <PageSkeleton rows={1} />;
}
