import { TextsScreen } from '@/components/phone/texts-screen';

/** Inbox → Texts (docs/adr/0070): the agent's own text conversations. */
export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <TextsScreen surface="agent" searchParams={searchParams} />;
}
