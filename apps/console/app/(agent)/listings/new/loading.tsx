import {
  ListingFormHeadingSkeleton,
  ListingFormSkeleton,
} from '@/components/listing-form-skeleton';

/**
 * The form's own shape while the permission check runs.
 *
 * No listing is read here, so this is short — but it is the same form, and
 * falling through to the group skeleton made Add listing paint the listings
 * table's shape first and then replace it.
 */
export default function Loading() {
  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <ListingFormHeadingSkeleton width={420} />
      <ListingFormSkeleton />
    </div>
  );
}
