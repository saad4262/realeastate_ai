import { WorkflowsSection } from '@/components/admin/sections';
import { requirePlatformView } from '@/lib/require-platform-admin';

export default async function Page({ params }: { params: Promise<{ agencyId: string; userId: string }> }) {
  const { agencyId, userId } = await params;
  const view = await requirePlatformView(agencyId, userId);
  return <WorkflowsSection view={view} />;
}
