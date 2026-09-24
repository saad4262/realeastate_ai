import { Suspense } from 'react';
import { PageSkeleton } from '@/components/page-skeleton';
import { AgentShell } from './agent-shell';
import {
  loadConsoleChrome,
  requireConsoleAccess,
  requireConsoleSession,
} from '../../lib/require-console-access';

/**
 * Agent desk chrome — same split as the agency layout: the session comes from
 * middleware's headers so the shell paints at once, and the two slow questions
 * sit behind their own boundaries.
 */
export default async function AgentLayout({ children }: { children: React.ReactNode }) {
  const session = await requireConsoleSession();
  const chrome = loadConsoleChrome(session.userId);

  return (
    <AgentShell userLabel={session.label} chrome={chrome}>
      <Suspense fallback={<PageSkeleton />}>
        <AgentGate>{children}</AgentGate>
      </Suspense>
    </AgentShell>
  );
}

/** can() still decides; children render only once it passes. */
async function AgentGate({ children }: { children: React.ReactNode }) {
  await requireConsoleAccess('agent');
  return <>{children}</>;
}
