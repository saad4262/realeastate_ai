import { PipelineBoard } from '@/components/deals/pipeline-board';

/** The Pipeline board (ADR 0063). Shared by both consoles; `?mine=1` narrows an owner's view to their own. */
export default async function Page({ searchParams }: { searchParams: Promise<{ mine?: string }> }) {
  const { mine } = await searchParams;
  return <PipelineBoard surface="agent" mine={mine === '1'} />;
}
