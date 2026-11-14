import { ControlCentreScreen } from '@/components/control-centre/control-centre-screen';

/** Automation → Control Centre (docs/adr/0091): everything the agency's automations did by themselves. */
export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <ControlCentreScreen surface="agency" searchParams={searchParams} />;
}
