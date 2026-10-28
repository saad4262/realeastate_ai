import { ListingPage, parseListingTab } from '@/components/listings/listing-page';

/** A listing's page, in tabs (ADR 0060): Details, Photos, Documents, Matching buyers. Shared with the agent desk. */
export default async function EditAgencyListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  return <ListingPage surface="agency" id={id} tab={parseListingTab(tab)} />;
}
