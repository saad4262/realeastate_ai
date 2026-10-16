import { DashboardsPage } from '@/components/dashboards/dashboards-page';

/** Projects on the agent desk — dashboards shared with this agent (docs/adr/0027). The body is shared with the agency console. */
export default function Page() {
  return <DashboardsPage surface="agent" />;
}
