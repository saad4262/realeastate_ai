import { redirect } from 'next/navigation';

/** Workflows are the Automations tab of Skills now (ADR 0058); old links and bookmarks land there. */
export default async function Page({ searchParams }: { searchParams: Promise<{ runs?: string }> }) {
  const { runs } = await searchParams;
  redirect(`/my-skills?tab=automations${runs ? `&runs=${encodeURIComponent(runs)}#runs` : ''}`);
}
