import { SkillRunPage } from '@/components/skills/run-page';

/** Skills (docs/adr/0021). The body is shared by both consoles. */
export default async function Page({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  return <SkillRunPage surface="agency" id={id} runId={runId} />;
}
