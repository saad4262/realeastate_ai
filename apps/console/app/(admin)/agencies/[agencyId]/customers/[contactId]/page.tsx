import { CustomerDetail } from '@/components/admin/sections';
import { requirePlatformView } from '@/lib/require-platform-admin';

export default async function Page({ params }: { params: Promise<{ agencyId: string; contactId: string }> }) {
  const { agencyId, contactId } = await params;
  const view = await requirePlatformView(agencyId);
  return <CustomerDetail view={view} base={`/agencies/${agencyId}`} contactId={contactId} />;
}
