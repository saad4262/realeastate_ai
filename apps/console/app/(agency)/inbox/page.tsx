import { InboxPage } from '@/components/inbox/inbox-page';

/**
 * The agency's email — every conversation with a buyer, and mail sent to the
 * agency's own address (docs/adr/0016). The body is shared with the agent
 * desk's /my-inbox; what an actor may see is decided in packages/core.
 */
export default function AgencyInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <InboxPage surface="agency" searchParams={searchParams} />;
}
