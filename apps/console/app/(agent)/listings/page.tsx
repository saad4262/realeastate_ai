import { can } from '@repo/core/permissions';
import { listAgencyListings } from '@repo/core/listings';
import { ListingTable } from '@/components/listing-table';
import { getConsoleDb } from '../../../lib/db';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/** The agent desk shows only the listings this agent is named on. */
export default async function AgentListingsPage() {
  const session = await requireConsoleAccess('agent');

  let rows: Awaited<ReturnType<typeof listAgencyListings>> = [];
  let loadError: string | null = null;

  try {
    rows = await listAgencyListings(getConsoleDb(), session.actor, { mine: true });
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

  // Decided by can(), not by looking at the role here — non-negotiable #2.
  // On this surface it is normally false: deleting is an agency-admin act, and
  // an admin who wants to do it has the agency console.
  const canDelete = can(session.actor, 'listing:delete', {
    type: 'listing',
    agencyId: session.actor.agencyId,
  });

  return (
    <ListingTable
      title="My Listings"
      subtitle="Listings you are named on. The agency book lives in the agency console."
      newHref="/listings/new"
      editHrefBase="/listings"
      canDelete={canDelete}
      emptyHint="Add a listing and you are recorded as its lead agent."
      rows={rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
    />
  );
}
