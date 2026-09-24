import { ListingForm } from '@/components/listing-form';
import { requireConsoleAccess } from '../../../../lib/require-console-access';

export default async function NewAgentListingPage() {
  await requireConsoleAccess('agent');

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: '1.5rem', letterSpacing: '-0.02em' }}>Add a listing</h1>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
          You are recorded as the lead agent. It saves as a draft until you publish it.
        </p>
      </div>
      <ListingForm backHref="/listings" />
    </div>
  );
}
