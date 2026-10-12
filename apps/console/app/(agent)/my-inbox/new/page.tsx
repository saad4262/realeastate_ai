import { ComposePage } from '@/components/inbox/compose-page';

/** A new email to one of the agent's contacts (ADR 0035 §1). */
export default function AgentNewEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ComposePage surface="agent" searchParams={searchParams} />;
}
