import { DashboardsPage } from '@/components/dashboards/dashboards-page';

/** Dashboards shared with the whole agency (docs/adr/0027). */
export default function Page() {
  return <DashboardsPage surface="agent" />;
}
