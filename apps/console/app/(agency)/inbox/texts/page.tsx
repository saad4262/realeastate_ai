import { TextsScreen } from '@/components/phone/texts-screen';

/** Inbox → Texts (docs/adr/0070): every agent's text conversations, to read. */
export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <TextsScreen surface="agency" searchParams={searchParams} />;
}
