import { PropertyPage, parsePropertyTab } from '@/components/properties/property-page';

/** One property with everything on it (ADR 0065), in tabs. Shared by both consoles; the tab is in the URL. */
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  return <PropertyPage surface="agent" id={id} tab={parsePropertyTab(tab)} />;
}
