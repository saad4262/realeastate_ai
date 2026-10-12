import { ComposePage } from '@/components/inbox/compose-page';

/** A new email to a contact, from the agency console (ADR 0035 §1). */
export default function AgencyNewEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ComposePage surface="agency" searchParams={searchParams} />;
}
