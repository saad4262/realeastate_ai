import { listAgencyLeads, type LeadKind, type LeadPage } from '@repo/core/leads';
import { LeadTable } from '@/components/lead-table';
import { getConsoleDb } from '../../../lib/db';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/**
 * The agency's lead inbox — the first screen that reads the `lead` table.
 *
 * Enquiries and private offers in one list, filtered by a tab. See LeadTable
 * for why they share a screen and why the tabs are load-bearing rather than a
 * convenience.
 *
 * The kind comes from the URL rather than component state, so Back works and a
 * filtered inbox can be sent to a colleague — the same reasoning the public
 * search pages through the URL.
 */
const KINDS = ['enquiry', 'inspection', 'appraisal', 'offer'] as const;

function parseKind(raw: string | string[] | undefined): LeadKind | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  // An unknown ?kind= falls back to everything rather than erroring: it is a
  // URL somebody may have typed, and the honest answer to a filter that does
  // not exist is the unfiltered list.
  return (KINDS as readonly string[]).includes(value ?? '') ? (value as LeadKind) : undefined;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess('agency');
  const kind = parseKind((await searchParams).kind);

  let result: LeadPage = {
    rows: [],
    counts: { total: 0, unread: 0, offers: 0 },
    maySeeOffers: false,
  };
  let loadError: string | null = null;

  try {
    result = await listAgencyLeads(getConsoleDb(), session.actor, {
      ...(kind ? { kind } : {}),
      limit: 50,
    });
  } catch (err) {
    /**
     * A refusal reads as a refusal.
     *
     * `listAgencyLeads` throws rather than returning an empty page when the
     * actor may not see the offers tab, because an empty list would read as
     * "no offers yet" to somebody who simply may not see them — and they would
     * stop looking.
     */
    loadError = err instanceof Error ? err.message : 'Failed to load leads';
  }

  if (loadError) {
    return (
      <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>
        {loadError}
      </p>
    );
  }

  return (
    <LeadTable
      /**
       * Where an offer's address can be read in full. The public property page
       * lives on the other host, so the console cannot route to it relatively —
       * and it only resolves while nothing there is on the market, which is
       * exactly when somebody looking at an offer wants it.
       */
      webUrl={process.env.NEXT_PUBLIC_WEB_URL ?? 'http://web.lvh.me:3000'}
      rows={result.rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
      counts={result.counts}
      {...(kind ? { kind } : {})}
      maySeeOffers={result.maySeeOffers}
    />
  );
}
