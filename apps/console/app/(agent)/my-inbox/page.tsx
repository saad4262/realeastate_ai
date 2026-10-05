import { InboxPage } from '@/components/inbox/inbox-page';

/**
 * The agent's email: conversations on the leads that are theirs (ADR 0014,
 * 0016). `/my-inbox` rather than `/inbox` because both route groups share one
 * URL space — the reason the desk's leads are `/my-leads`.
 */
export default function AgentInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <InboxPage surface="agent" searchParams={searchParams} />;
}
