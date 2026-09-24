import { ListingForm } from '@/components/listing-form';
import { requireConsoleAccess } from '../../../../lib/require-console-access';

export default async function NewAgencyListingPage() {
  await requireConsoleAccess('agency');

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
          Add a listing
        </h1>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
          The property and the advertisement are stored separately, so re-listing the same address
          later keeps its history.
        </p>
      </div>
      <ListingForm backHref="/live-listings" />
    </div>
  );
}
