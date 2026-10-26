import { KnowledgePage } from '@/components/documents/knowledge-page';

/** The agency knowledge base (docs/adr/0053). The body is shared by both consoles. */
export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <KnowledgePage surface="agent" searchParams={searchParams} />;
}
