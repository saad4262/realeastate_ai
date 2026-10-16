import { Suspense } from 'react';
import { AssistantHome } from '@/components/assistant/assistant-home';
import { NeedsOwner } from '@/components/offboarding/needs-owner';
import { UpcomingMeetings } from '@/components/appointments/upcoming-meetings';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/**
 * The agency console's home: the assistant, centred, as the page itself.
 *
 * The two real notices this page always carried stay — an offboarded member
 * whose work needs a new owner above the greeting, and the next meetings
 * under the composer. The demo briefing, KPIs and recommendations that used
 * to fill it were sample figures, labelled as such; they are gone rather than
 * moved, because nothing on this page may show a number that is not SQL's.
 */
export default async function AgencyHomePage() {
  const session = await requireConsoleAccess('agency');
  const name = session.userLabel.split(/\s+/)[0] || null;
  return (
    <Suspense fallback={null}>
      <AssistantHome
        surface="agency"
        home="/overview"
        name={name}
        notices={
          <Suspense fallback={null}>
            <NeedsOwner actor={session.actor} />
          </Suspense>
        }
        below={
          <Suspense fallback={null}>
            <UpcomingMeetings actor={session.actor} surface="agency" />
          </Suspense>
        }
      />
    </Suspense>
  );
}
