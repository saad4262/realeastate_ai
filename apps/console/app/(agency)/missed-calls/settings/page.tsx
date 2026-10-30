import { MissedCallsScreen } from '@/components/phone/missed-calls-screen';

/** Missed calls → Settings (docs/adr/0071): the greeting, the text and the daily limits. */
export default function Page() {
  return <MissedCallsScreen surface="agency" tab="settings" />;
}
