import { ContactPage } from '@/components/contacts/contact-page';

/**
 * Contact 360 (ADR 0018). A contact this actor may not see answers exactly
 * like one that does not exist, so ids cannot be probed; a merged contact
 * sends you on to the one it was merged into. The body is shared with the
 * other console — see ContactPage.
 */
export default function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ContactPage surface="agent" params={params} searchParams={searchParams} />;
}
