import { DashboardsPage } from '@/components/dashboards/dashboards-page';

/** Projects — the agency console's name for dashboards (docs/adr/0027). The body is shared with the agent desk. */
export default function Page() {
  return <DashboardsPage surface="agency" />;
}
