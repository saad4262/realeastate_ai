import { SkillPage } from '@/components/skills/skill-page';

/** Skills (docs/adr/0021). The body is shared by both consoles. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SkillPage surface="agent" id={id} />;
}
