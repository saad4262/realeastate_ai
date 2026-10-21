import { Suspense } from 'react';
import { AdminShell } from '@/components/admin/admin-shell';
import { PageSkeleton } from '@/components/page-skeleton';
import { requireConsoleSession } from '../../lib/require-console-access';
import { requirePlatformAdmin } from '../../lib/require-platform-admin';

/**
 * The platform admin console (ADR 0049) — admin.* only; middleware keeps these
 * paths off the agency and agent hosts and everything else off this one.
 *
 * The shell paints from middleware's headers; whether this account is a
 * platform admin is asked behind Suspense, and nothing below renders until it
 * says yes. Every page asks again (requirePlatformAdmin is cached per request),
 * so a page never depends on this gate alone.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireConsoleSession();
  return (
    <AdminShell userLabel={session.label}>
      <Suspense fallback={<PageSkeleton />}>
        <AdminGate>{children}</AdminGate>
      </Suspense>
    </AdminShell>
  );
}

async function AdminGate({ children }: { children: React.ReactNode }) {
  await requirePlatformAdmin();
  return <>{children}</>;
}
