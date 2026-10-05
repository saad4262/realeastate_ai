import { IntegrationsPage } from '@/components/integrations/integrations-page';

/** An agent's integrations: their own accounts, and the agency's to look at. */
export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <IntegrationsPage surface="agent" searchParams={searchParams} />;
}
