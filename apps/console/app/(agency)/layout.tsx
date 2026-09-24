import { Suspense } from 'react';
import { PageSkeleton } from '@/components/page-skeleton';
import { AgencyShell } from './agency-shell';
import {
  loadConsoleChrome,
  requireConsoleAccess,
  requireConsoleSession,
} from '../../lib/require-console-access';

/**
 * Agency chrome.
 *
 * The session is read from the headers middleware already set, so the sidebar,
 * nav and page skeleton paint immediately. Both slow questions — what this
 * account may see, and what the header should show — resolve behind their own
 * Suspense boundaries instead of holding the whole console.
 */
export default async function AgencyLayout({ children }: { children: React.ReactNode }) {
  const session = await requireConsoleSession();

  // Deliberately not awaited. The shell reads this behind Suspense; awaiting it
  // here is exactly what used to leave the screen blank for a whole round trip.
  const chrome = loadConsoleChrome(session.userId);

  return (
    <AgencyShell userLabel={session.label} chrome={chrome}>
      <Suspense fallback={<PageSkeleton />}>
        <AgencyGate>{children}</AgencyGate>
      </Suspense>
    </AgencyShell>
  );
}

/**
 * The authorisation gate, on the far side of the boundary.
 *
 * can() still decides and children still render only once it passes — the
 * skeleton is what a visitor sees while it runs, never the page. Placeholder
 * pages that do not call requireConsoleAccess themselves stay covered by this.
 */
async function AgencyGate({ children }: { children: React.ReactNode }) {
  await requireConsoleAccess('agency');
  return <>{children}</>;
}
