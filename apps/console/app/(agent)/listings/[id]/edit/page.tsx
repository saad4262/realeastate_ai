import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { getListingForEdit } from '@repo/core/listings';
import { MAX_LISTING_PHOTOS, listingPhotos } from '@repo/core/media';
import { ListingForm } from '@/components/listing-form';
import { ListingPhotosSkeleton } from '@/components/listing-form-skeleton';
import { ListingPhotos } from '@/components/photo-uploader';
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
      <Suspense fallback={<ListingPhotosSkeleton />}>
        <Photos listingId={id} />
      </Suspense>
    </div>
  );
}

/**
 * The photo panel, on the far side of a boundary.
 *
 * After the listing, not beside it. getListingForEdit is what decides whether
 * this id is visible to this actor at all — another agency's listing is a 404
 * there — so starting the media read in parallel with it would fetch photos for
 * a listing the caller may not be allowed to see. This component renders only
 * once that check has passed, which keeps the ordering, and behind Suspense the
 * form no longer waits for the second round trip: it is on screen and typeable
 * while the photos arrive. Awaiting it in the page body cost every edit a whole
 * extra trip to the database region before anything painted.
 */
async function Photos({ listingId }: { listingId: string }) {
  const photos = await listingPhotos(getConsoleDb(), listingId);
  return <ListingPhotos listingId={listingId} photos={photos} max={MAX_LISTING_PHOTOS} />;
}
