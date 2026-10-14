import { IntegrationsPage } from '@/components/integrations/integrations-page';

/** The agency's connectors (formerly Integrations): its own accounts (Zoom, Reviews, Sheets) and the admin's own. */
export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <IntegrationsPage surface="agency" searchParams={searchParams} />;
}
