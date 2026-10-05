import { BatchPage } from '@/components/bulk-email/batch-page';

/** One batch: the frozen list, the preview, Approve & Send. */
export default async function Page({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  return <BatchPage surface="agent" id={batchId} />;
}
