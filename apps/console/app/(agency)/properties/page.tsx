import { PropertiesList, propertiesParams } from '@/components/properties/properties-list';

/** Properties (ADR 0065): every address this person may open. Shared by both consoles; search, filter and page are in the URL. */
export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string | string[]; filter?: string | string[]; page?: string | string[] }> }) {
  return <PropertiesList surface="agency" {...propertiesParams(await searchParams)} />;
}
