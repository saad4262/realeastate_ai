import { can } from '@repo/core/permissions';
import { listAgencyListings } from '@repo/core/listings';
import { ListingTable } from '@/components/listing-table';
import { getConsoleDb } from '../../../lib/db';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/**
 * The agency book: every listing the agency holds, drafts included.
 *
 * Replaces the Stitch mock that shipped here with hardcoded rows — the shape
 * is the same, the numbers are now the ones in the database.
 */
export default async function AgencyListingsPage() {
  const session = await requireConsoleAccess('agency');

  let rows: Awaited<ReturnType<typeof listAgencyListings>> = [];
  let loadError: string | null = null;

  try {
    rows = await listAgencyListings(getConsoleDb(), session.actor);
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Failed to load listings';
  }

  if (loadError) {
    return (
      <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>
        {loadError}
      </p>
    );
  }

  // The one place the delete button's visibility is decided, and it is decided
  // by can() — non-negotiable #2. deleteListing asks the same question again on
  // the server, so hiding the button is a courtesy, never the control.
  const canDelete = can(session.actor, 'listing:delete', {
    type: 'listing',
    agencyId: session.actor.agencyId,
  });

  return (
    <ListingTable
      title="Listings"
      subtitle="Every listing in the agency book. Drafts are private until you publish them."
      newHref="/live-listings/new"
      editHrefBase="/live-listings"
      canDelete={canDelete}
      emptyHint="Add your first listing — it saves as a draft, so nothing goes public by accident."
      // Dates do not cross the server/client boundary intact.
      rows={rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
    />
  );
}
