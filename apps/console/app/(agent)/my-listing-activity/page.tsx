import { ListingActivityPage } from '@/components/contacts/listing-activity-page';
import { requireConsoleAccess } from '@/lib/require-console-access';

/** People → Listing activity (ADR 0083): who looked at the listings this agent is named on. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireConsoleAccess('agent');
  return <ListingActivityPage actor={session.actor} basePath="/my-listing-activity" contactBase="/my-contacts" scopeWords="your listings" searchParams={searchParams} />;
}
