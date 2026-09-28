import {
  ListingFormHeadingSkeleton,
  ListingFormSkeleton,
  ListingPhotosSkeleton,
} from '@/components/listing-form-skeleton';

/**
 * Shown the instant Edit is clicked, before the server has the row.
 *
 * This route waits on two round trips to the database region, so without a
 * boundary of its own it fell through to the route group's loading.tsx — a
 * title, three stat tiles and a card, which is the shape of the listings table
 * and not of this page. ARCHITECTURE.md § 10: the loader renders this page's
 * own chrome, so the transition is a fill rather than a flash.
 */
export default function Loading() {
  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <ListingFormHeadingSkeleton />
      <ListingFormSkeleton />
      <ListingPhotosSkeleton />
    </div>
  );
}
