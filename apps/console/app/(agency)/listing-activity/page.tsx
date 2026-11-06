import { ListingActivityPage } from '@/components/contacts/listing-activity-page';
import { requireConsoleAccess } from '@/lib/require-console-access';

/** People → Listing activity (ADR 0083): who looked at the agency's own listings. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireConsoleAccess('agency');
  return <ListingActivityPage actor={session.actor} basePath="/listing-activity" contactBase="/customers" scopeWords="your agency’s listings" searchParams={searchParams} />;
}
