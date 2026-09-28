import { Suspense } from 'react';
import { listAgencyAgents, listAgencyInvites } from '@repo/core/team';
import { getConsoleDb } from '../../../lib/db';
import { requireConsoleAccess } from '../../../lib/require-console-access';
import { TeamSkeleton } from './team-skeleton';
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
   * Deliberately NOT keyed on tab or agent.
   *
   * It used to be `key={`${tab}:${selectedId}`}`, and that made every click in
   * the directory — a tab, an agent's name — throw the whole roster away and
   * paint a skeleton while it came back. But neither parameter reaches the
   * database: `listAgencyAgents` and `listAgencyInvites` take the actor and
   * nothing else, and the tab filter, the three counts and the open dossier are
   * all computed in TeamDirectory from the same array. The rows on screen are
   * already the right rows for the new tab.
   *
   * ARCHITECTURE.md § 5: key a boundary on the query, not on the raw params.
   * The query here is constant, so there is no key. A navigation is a React
   * transition, so the roster you are looking at stays on screen and is
   * replaced when the re-render lands, instead of blinking through a loader.
   *
   * Contrast apps/web/app/search/page.tsx, where the params ARE the query and
   * keying is correct.
   */
  return (
    <Suspense fallback={<TeamSkeleton />}>
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
