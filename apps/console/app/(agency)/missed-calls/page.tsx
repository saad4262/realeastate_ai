import { MissedCallsScreen } from '@/components/phone/missed-calls-screen';

/** Daily work → Missed calls (docs/adr/0071): every agent's missed calls; `?call=` opens one. */
export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <MissedCallsScreen surface="agency" searchParams={searchParams} />;
}
