import { TeamMessagesPage } from '@/components/team-messages/team-messages-page';

/** The agent's team messages (ADR 0035 §3) — `/my-messages`, as both route groups share one URL space. */
export default function AgentTeamMessagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <TeamMessagesPage surface="agent" searchParams={searchParams} />;
}
