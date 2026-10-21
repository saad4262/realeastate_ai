import { EmailsSection } from '@/components/admin/emails-section';
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
  return <EmailsSection view={view} base={`/agencies/${agencyId}`} params={await searchParams} />;
}
