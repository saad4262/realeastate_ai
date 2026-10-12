import { TeamMessagesPage } from '@/components/team-messages/team-messages-page';

/**
 * Team messages from the agency console (ADR 0035 §3). The body is shared with
 * the agent desk's /my-messages; who may read what is decided in packages/core.
 */
export default function AgencyTeamMessagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <TeamMessagesPage surface="agency" searchParams={searchParams} />;
}
