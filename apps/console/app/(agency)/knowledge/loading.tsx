import { PageSkeleton } from '@/components/page-skeleton';

/** The knowledge base's shape while the database answers. */
export default function Loading() {
  return <PageSkeleton rows={2} />;
}
