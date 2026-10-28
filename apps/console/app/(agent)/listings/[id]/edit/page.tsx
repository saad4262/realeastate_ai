import { ListingPage, parseListingTab } from '@/components/listings/listing-page';

/**
 * A listing's page, in tabs (ADR 0060). Opening it needs listing:read; saving needs listing:edit, which is
 * narrower and is enforced in updateListing — an agent not named on the listing can look and is refused on
 * save, the right way round for a shared agency book.
 */
export default async function EditAgentListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  return <ListingPage surface="agent" id={id} tab={parseListingTab(tab)} />;
}
