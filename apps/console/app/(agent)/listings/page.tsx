import { can } from '@repo/core/permissions';
import {
  CONSOLE_PAGE_SIZE,
  consolePage,
  listAgencyListingsPage,
  type ListingPage,
} from '@repo/core/listings';
import { ListingTable } from '@/components/listing-table';
import { getConsoleDb } from '../../../lib/db';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/** The agent desk shows only the listings this agent is named on. Paged, like
 *  the agency book, and through the same query — the counts in the header are
 *  Postgres's, over this agent's listings rather than the whole agency's. */
export default async function AgentListingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess('agent');
  const page = consolePage((await searchParams).page);

  let result: ListingPage = { rows: [], counts: { total: 0, live: 0, draft: 0, pending: 0 } };
  let loadError: string | null = null;

  try {
    result = await listAgencyListingsPage(getConsoleDb(), session.actor, {
      mine: true,
      limit: CONSOLE_PAGE_SIZE,
      offset: (page - 1) * CONSOLE_PAGE_SIZE,
    });
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

  // Publish vs submit for approval (ADR 0014), decided by can() like delete.
  const mayPublish = can(session.actor, 'listing:publish', {
    type: 'listing',
    agencyId: session.actor.agencyId,
  });

  return (
    <ListingTable
      title="My Listings"
      subtitle="Listings you are named on. Submit a draft for approval and an owner or admin publishes it."
      newHref="/listings/new"
      editHrefBase="/listings"
      canDelete={canDelete}
      mayPublish={mayPublish}
      emptyHint="Add a listing and you are recorded as its lead agent."
      counts={result.counts}
      page={page}
      pageSize={CONSOLE_PAGE_SIZE}
      basePath="/listings"
      rows={result.rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        soldDate: r.soldDate?.toISOString() ?? null,
      }))}
    />
  );
}
