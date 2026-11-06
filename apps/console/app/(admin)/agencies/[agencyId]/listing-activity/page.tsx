import { ListingActivityPage } from '@/components/contacts/listing-activity-page';
import { recordPlatformView, requirePlatformView } from '@/lib/require-platform-admin';

/** The admin's view of an agency's Listing activity (ADR 0083): the agency's page, read only, logged. */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ agencyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { agencyId } = await params;
  const view = await requirePlatformView(agencyId);
  await recordPlatformView(view.actor, 'listing_activity', agencyId);
  const base = `/agencies/${agencyId}`;
  return <ListingActivityPage actor={view.actor} basePath={`${base}/listing-activity`} contactBase={`${base}/customers`} scopeWords="this agency’s listings" searchParams={searchParams} />;
}
