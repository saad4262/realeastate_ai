import { notFound } from 'next/navigation';
import { getListingForEdit } from '@repo/core/listings';
import { ListingForm } from '@/components/listing-form';
import { getConsoleDb } from '../../../../../lib/db';
import { requireConsoleAccess } from '../../../../../lib/require-console-access';

export default async function EditAgentListingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireConsoleAccess('agent');

  // Opening the form needs listing:read; saving needs listing:edit, which is
  // narrower and is enforced in updateListing. An agent not named on the
  // listing can therefore look at it and will be refused on save — which is
  // the right way round for a shared agency book.
  const listing = await getListingForEdit(getConsoleDb(), session.actor, id);
  if (!listing) notFound();

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: '1.5rem', letterSpacing: '-0.02em' }}>Edit listing</h1>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
          {listing.address}
        </p>
      </div>
      <ListingForm backHref="/listings" initial={listing} />
    </div>
  );
}
