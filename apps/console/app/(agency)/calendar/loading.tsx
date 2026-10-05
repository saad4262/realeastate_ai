import { PageSkeleton } from '@/components/page-skeleton';

/** The calendar's shape while the database answers: a title, controls, a list. */
export default function Loading() {
  return <PageSkeleton rows={1} />;
}
