import { Suspense } from 'react';
import { PageSkeleton } from '@/components/page-skeleton';
import { ConsoleShell } from '@/components/shell/console-shell';
import {
  loadConsoleChrome,
  requireConsoleAccess,
  requireConsoleSession,
} from '../../lib/require-console-access';

/**
 * Agent desk chrome — the same shell as the agency console, and the same split: the session comes from
 * middleware's headers so the shell paints at once, and the two slow questions
 * sit behind their own boundaries.
 */
export default async function AgentLayout({ children }: { children: React.ReactNode }) {
  const session = await requireConsoleSession();
  const chrome = loadConsoleChrome(session.userId);

  return (
    <ConsoleShell surface="agent" userLabel={session.label} userId={session.userId} chrome={chrome}>
      <Suspense fallback={<PageSkeleton />}>
        <AgentGate>{children}</AgentGate>
      </Suspense>
    </ConsoleShell>
  );
}

/** can() still decides; children render only once it passes. */
async function AgentGate({ children }: { children: React.ReactNode }) {
  await requireConsoleAccess('agent');
  return <>{children}</>;
}
