import { WorkflowsSection } from '@/components/admin/sections';
import { requirePlatformView } from '@/lib/require-platform-admin';

export default async function Page({ params }: { params: Promise<{ agencyId: string }> }) {
  const { agencyId } = await params;
  const view = await requirePlatformView(agencyId);
  return <WorkflowsSection view={view} />;
}
