import { CustomerDetail } from '@/components/admin/sections';
import { requirePlatformView } from '@/lib/require-platform-admin';

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ agencyId: string; contactId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { agencyId, contactId } = await params;
  const { page } = await searchParams;
  const view = await requirePlatformView(agencyId);
  return <CustomerDetail view={view} base={`/agencies/${agencyId}`} contactId={contactId} activityPage={Number(Array.isArray(page) ? page[0] : page) || 1} />;
}
