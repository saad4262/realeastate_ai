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

/**
 * The agency book: every listing the agency holds, drafts included.
 *
 * Paged. It used to select the whole book on every load, because the table's
 * Live and Drafts figures were counted in the browser from the rows it had
 * been sent — so the counts were only correct if it had been sent all of them.
 * Postgres counts them now, over the same scan, and this asks for one page.
 */
export default async function AgencyListingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess('agency');
  const page = consolePage((await searchParams).page);

  let result: ListingPage = { rows: [], counts: { total: 0, live: 0, draft: 0 } };
  let loadError: string | null = null;

  try {
    result = await listAgencyListingsPage(getConsoleDb(), session.actor, {
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
      counts={result.counts}
      page={page}
      pageSize={CONSOLE_PAGE_SIZE}
      basePath="/live-listings"
      // Dates do not cross the server/client boundary intact.
      rows={result.rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
    />
  );
}
