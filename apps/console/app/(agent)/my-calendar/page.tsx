import { CalendarPage } from '@/components/appointments/calendar-page';

/** The agent's calendar (ADR 0019): only their own appointments, narrowed in packages/core. */
export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <CalendarPage surface="agent" searchParams={searchParams} />;
}
