import { Suspense } from 'react';
import { listAgencyAgents, listAgencyInvites } from '@repo/core/team';
import { PageSkeleton } from '@/components/page-skeleton';
import { getConsoleDb } from '../../../lib/db';
import { requireConsoleAccess } from '../../../lib/require-console-access';
import { PendingInvites } from './pending-invites';
import { TeamDirectory, teamTabOf } from './team-directory';

/**
 * The roster, filtered by the URL.
 *
 * ?tab= and ?agent= are read here and handed down; the directory holds no
 * state of its own any more. A change to either is an ordinary navigation, so
 * it is shareable, it is in the Back history, and it survives a reload.
 */
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (k: string) => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const tab = teamTabOf(one('tab'));
  const selectedId = one('agent')?.trim() || '';

  /**
   * Keyed on the two parameters, so switching tab or agent shows the skeleton
   * rather than the previous roster.
   *
   * A searchParams-only change re-renders the page but does NOT trigger
   * loading.tsx — no route segment changed — so without this boundary the old
   * table would sit there until the new one arrived. Same pattern as
   * apps/web/app/search/page.tsx.
   */
  return (
    <Suspense key={`${tab}:${selectedId}`} fallback={<PageSkeleton rows={3} />}>
      <Roster tab={tab} selectedId={selectedId} />
    </Suspense>
  );
}

async function Roster({ tab, selectedId }: { tab: ReturnType<typeof teamTabOf>; selectedId: string }) {
  const session = await requireConsoleAccess('agency');

  let agents: Awaited<ReturnType<typeof listAgencyAgents>> = [];
  let invites: Awaited<ReturnType<typeof listAgencyInvites>> = [];
  let loadError: string | null = null;

  try {
    const db = getConsoleDb();
    [agents, invites] = await Promise.all([
      listAgencyAgents(db, session.actor),
      listAgencyInvites(db, session.actor),
    ]);
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Failed to load team';
  }

  return (
    <TeamDirectory
      agents={agents}
      loadError={loadError}
      tab={tab}
      selectedId={selectedId}
      // Dates do not cross the server/client boundary intact, so the panel
      // takes ISO strings and parses them for the countdown.
      invites={
        <PendingInvites
          invites={invites.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString() }))}
        />
      }
    />
  );
}
