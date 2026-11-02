import { SmsBatchPage } from '@/components/bulk-sms/sms-batch-page';

/** One SMS batch: the frozen list, the number each text goes from, the preview, Approve & Send. */
export default async function Page({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  return <SmsBatchPage surface="agent" id={batchId} />;
}
