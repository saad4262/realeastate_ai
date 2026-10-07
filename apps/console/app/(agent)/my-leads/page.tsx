import { listAgencyLeads, listReassignedAway, type LeadKind, type LeadPage } from '@repo/core/leads';
import { LeadTable } from '@/components/lead-table';
import { LocalTime } from '@repo/ui';
import { getConsoleDb } from '../../../lib/db';
import { loadListingActor } from '../../../lib/load-actor';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/**
 * The agent desk's lead inbox: the agent's OWN leads (ADR 0014).
 *
 * The same core read and the same table as the agency's /leads. What makes it
 * "mine" is not this page — it is `listAgencyLeads`, which narrows any actor
 * without `lead:read_all` in SQL to the leads assigned to them (the client's
 * rule, 2026-10-07). So the agency's book cannot leak in through a
 * missing filter here, and the tab counts describe this agent's leads only.
 *
 * `/my-leads` rather than `/leads` because both route groups share one URL
 * space, the same reason the agent's listings are `/listings` and the
 * agency's `/live-listings`.
 */
const KINDS = ['enquiry', 'inspection', 'appraisal'] as const;

function parseKind(raw: string | string[] | undefined): LeadKind | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (KINDS as readonly string[]).includes(value ?? '') ? (value as LeadKind) : undefined;
}

export default async function AgentLeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess('agent');
  const kind = parseKind((await searchParams).kind);

  let result: LeadPage = {
    rows: [],
    counts: { total: 0, unread: 0, offers: 0 },
    maySeeOffers: false,
    mayAssign: false,
  };
  let loadError: string | null = null;
  // Leads an owner or admin gave to someone else: a note each, nothing more.
  let reassigned: { id: string; at: Date; message: string }[] = [];

  try {
    // With listing links: whether an unassigned lead from their own listing
    // can be worked is decided by can() against them (`mayUpdate` per row).
    const actor = (await loadListingActor(session.actor.userId)) ?? session.actor;
    [result, reassigned] = await Promise.all([
      listAgencyLeads(getConsoleDb(), actor, {
        ...(kind ? { kind } : {}),
        limit: 50,
      }),
      listReassignedAway(getConsoleDb(), actor),
    ]);
  } catch (err) {
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
    <>
    {reassigned.length ? (
      <ul aria-label="Reassigned leads" style={{ listStyle: 'none', margin: '1rem 1rem 0', padding: 0, display: 'grid', gap: '0.4rem' }}>
        {reassigned.map((n) => (
          <li key={n.id} style={{ padding: '0.6rem 0.8rem', border: '1px solid var(--line, #ddd)', borderRadius: 8, color: 'var(--muted, #666)' }}>
            {n.message}{' '}
            (<LocalTime iso={n.at.toISOString()} style="short" />)
          </li>
        ))}
      </ul>
    ) : null}
    <LeadTable
      basePath="/my-leads"
      inboxPath="/my-inbox"
      title="My leads"
      subtitle="Leads assigned to you."
      webUrl={process.env.NEXT_PUBLIC_WEB_URL ?? 'http://web.lvh.me:3000'}
      rows={result.rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
      counts={result.counts}
      {...(kind ? { kind } : {})}
      maySeeOffers={result.maySeeOffers}
      // Assigning is an admin decision; an agent's table draws names, not pickers.
      assignees={[]}
    />
    </>
  );
}
