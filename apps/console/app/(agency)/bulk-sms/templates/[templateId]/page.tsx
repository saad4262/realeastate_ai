import { SmsTemplatePage } from '@/components/bulk-sms/sms-template-page';

/** One SMS template. */
export default async function Page({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params;
  return <SmsTemplatePage surface="agency" id={templateId} />;
}
