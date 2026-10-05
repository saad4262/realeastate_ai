import { TemplatePage } from '@/components/bulk-email/template-page';

/** One template. */
export default async function Page({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params;
  return <TemplatePage surface="agency" id={templateId} />;
}
