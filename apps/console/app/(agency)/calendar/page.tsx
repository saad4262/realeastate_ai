import { CalendarPage } from '@/components/appointments/calendar-page';

/** The agency's calendar (ADR 0019): every appointment, for owners and admins. */
export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <CalendarPage surface="agency" searchParams={searchParams} />;
}
