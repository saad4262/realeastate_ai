import { DashboardsPage } from '@/components/dashboards/dashboards-page';

/** Dashboards (docs/adr/0027). The body is shared by both consoles. */
export default function Page() {
  return <DashboardsPage surface="agency" />;
}
