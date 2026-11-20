import { Suspense } from 'react';
import { AssistantHome } from '@/components/assistant/assistant-home';
import { NeedsOwner } from '@/components/offboarding/needs-owner';
import { OvernightFailures } from '@/components/safety/overnight-failures';
import { UpcomingMeetings } from '@/components/appointments/upcoming-meetings';
import { OpportunitiesPanel } from '@/components/opportunities/opportunities-panel';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/**
 * The agency console's home: the assistant, centred, as the page itself.
 *
 * The real notices stay — last night's failures (PLATFORM-PLAN 3.7) and an
 * offboarded member whose work needs a new owner above the greeting, and the next meetings
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
          <>
            {/* PLATFORM-PLAN 3.7: last night's failures, owners and admins; its own boundary. */}
            <Suspense fallback={null}>
              <OvernightFailures actor={session.actor} />
            </Suspense>
            <Suspense fallback={null}>
              <NeedsOwner actor={session.actor} />
            </Suspense>
          </>
        }
        below={
          <>
            {/* ADR 0054: what the hourly scan noticed for this person; its own boundary, so neither card waits on the other. */}
            <Suspense fallback={null}>
              <OpportunitiesPanel actor={session.actor} surface="agency" />
            </Suspense>
            <Suspense fallback={null}>
              <UpcomingMeetings actor={session.actor} surface="agency" />
            </Suspense>
          </>
        }
      />
    </Suspense>
  );
}
