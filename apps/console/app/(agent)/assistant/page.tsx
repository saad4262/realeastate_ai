import { Suspense } from 'react';
import { AssistantHome } from '@/components/assistant/assistant-home';
import { UpcomingMeetings } from '@/components/appointments/upcoming-meetings';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/**
 * The agent desk's home: the same assistant page as the agency console's
 * /overview. What it may look up or propose is decided by the server for this
 * agent (can()), exactly as it was in the panel — the page only lays it out.
 */
export default async function AgentHomePage() {
  const session = await requireConsoleAccess('agent');
  const name = session.userLabel.split(/\s+/)[0] || null;
  return (
    <Suspense fallback={null}>
      <AssistantHome
        surface="agent"
        home="/assistant"
        name={name}
        below={
          <Suspense fallback={null}>
            <UpcomingMeetings actor={session.actor} surface="agent" />
          </Suspense>
        }
      />
    </Suspense>
  );
}
