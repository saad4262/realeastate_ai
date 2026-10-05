import { InboxSkeleton } from '@/components/inbox/inbox-skeleton';

/** This route's own loader, in the inbox's shape (ARCHITECTURE § 10). */
export default function Loading() {
  return <InboxSkeleton />;
}
