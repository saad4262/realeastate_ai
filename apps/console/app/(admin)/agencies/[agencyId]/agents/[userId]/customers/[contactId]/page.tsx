import { CustomerDetail } from '@/components/admin/sections';
import { requirePlatformView } from '@/lib/require-platform-admin';

export default async function Page({ params }: { params: Promise<{ agencyId: string; userId: string; contactId: string }> }) {
  const { agencyId, userId, contactId } = await params;
  const view = await requirePlatformView(agencyId, userId);
  return <CustomerDetail view={view} base={`/agencies/${agencyId}/agents/${userId}`} contactId={contactId} />;
}
