import { PageSkeleton } from '@/components/page-skeleton';

/** The shape of this page while the database answers: a title, controls, a card. */
export default function Loading() {
  return <PageSkeleton rows={1} />;
}
