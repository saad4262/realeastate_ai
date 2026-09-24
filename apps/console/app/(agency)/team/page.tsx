import { listAgencyAgents, listAgencyInvites } from '@repo/core/team';
import { getConsoleDb } from '../../../lib/db';
import { requireConsoleAccess } from '../../../lib/require-console-access';
import { PendingInvites } from './pending-invites';
import { TeamDirectory } from './team-directory';

export default async function TeamPage() {
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
