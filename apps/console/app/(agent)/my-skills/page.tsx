import { SkillsPage, skillsParams } from '@/components/skills/skills-page';

/** Skills — the Control Centre (ADR 0058). The body is shared by both consoles; the tab is in the URL. */
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string; show?: string; runs?: string }> }) {
  return <SkillsPage surface="agent" {...skillsParams(await searchParams)} />;
}
