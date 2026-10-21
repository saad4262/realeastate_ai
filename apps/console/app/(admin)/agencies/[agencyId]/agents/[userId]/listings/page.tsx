import { ListingsSection } from '@/components/admin/sections';
import { requirePlatformView } from '@/lib/require-platform-admin';

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ agencyId: string; userId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { agencyId, userId } = await params;
  const view = await requirePlatformView(agencyId, userId);
  return <ListingsSection view={view} base={`/agencies/${agencyId}/agents/${userId}`} params={await searchParams} />;
}
