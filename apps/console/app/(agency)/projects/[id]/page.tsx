import { ProjectPage } from '@/components/dashboards/project-page';

export const dynamic = 'force-dynamic';

/** One project inside the agency console (see ProjectPage). Queries through getConsoleDb, so it has its own loading.tsx. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <ProjectPage surface="agency" id={(await params).id} />;
}
