/**
 * Legacy thin wrapper — prefer AgencyShell / AgentShell per route group.
 * Kept for any residual imports; new console UI must not use this.
 */
import { headers } from 'next/headers';
import { AppShell, type Surface } from '@repo/ui';

async function getSurface(): Promise<Surface> {
  const h = await headers();
  const raw = h.get('x-console-surface');
  if (raw === 'agency') return 'agency';
  return 'agent';
}

export default async function ConsoleShell({ children }: { children: React.ReactNode }) {
  const surface = await getSurface();
  return <AppShell surface={surface}>{children}</AppShell>;
}
