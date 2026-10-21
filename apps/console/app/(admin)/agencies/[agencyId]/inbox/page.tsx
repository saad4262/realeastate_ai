import { InboxSection } from '@/components/admin/sections';
import { requirePlatformView } from '@/lib/require-platform-admin';

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ agencyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { agencyId } = await params;
  const view = await requirePlatformView(agencyId);
  return <InboxSection view={view} base={`/agencies/${agencyId}`} params={await searchParams} />;
}
