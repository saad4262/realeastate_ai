import { PageSkeleton } from '@/components/page-skeleton';

/** The integrations page's shape while the database answers. */
export default function Loading() {
  return <PageSkeleton rows={1} />;
}
