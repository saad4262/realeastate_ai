import { notFound } from 'next/navigation';
import { getListingForEdit } from '@repo/core/listings';
import { ListingForm } from '@/components/listing-form';
import { getConsoleDb } from '../../../../../lib/db';
import { requireConsoleAccess } from '../../../../../lib/require-console-access';

export default async function EditAgencyListingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireConsoleAccess('agency');

  // Agency-scoped inside getListingForEdit, so another agency's id is a 404
  // here rather than a permission error that confirms the listing exists.
  const listing = await getListingForEdit(getConsoleDb(), session.actor, id);
  if (!listing) notFound();

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div>
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--font-display, inherit)',
            fontSize: '1.5rem',
            letterSpacing: '-0.02em',
          }}
        >
          Edit listing
        </h1>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
          {listing.address}
        </p>
      </div>
      <ListingForm backHref="/live-listings" initial={listing} />
    </div>
  );
}
