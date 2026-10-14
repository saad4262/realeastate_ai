import { WorkflowsPage } from '@/components/workflows/workflows-page';

/** Workflows (ADR 0041 Part C). The body is shared by both consoles. */
export default async function Page({ searchParams }: { searchParams: Promise<{ runs?: string }> }) {
  const { runs } = await searchParams;
  return <WorkflowsPage surface="agent" {...(runs ? { runsOf: runs } : {})} />;
}
