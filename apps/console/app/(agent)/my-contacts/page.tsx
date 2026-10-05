import {
  contactListQuerySchema,
  listContactAssignees,
  listContacts,
  type ContactAssignee,
  type ContactPage,
} from '@repo/core/contacts';
import { ContactDirectory } from '@/components/contacts/contact-directory';
import { getConsoleDb } from '../../../lib/db';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/**
 * My contacts (ADR 0018). Which contacts are listed is decided in packages/core by
 * can() and its SQL twin — the agent's own, and the people they meet through their leads and listings.
 * Filters come from the URL; anything unrecognised is dropped, not refused.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess('agent');
  const raw = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const query = contactListQuerySchema.parse({
    q: first(raw.q),
    role: first(raw.role) || undefined,
    source: first(raw.source) || undefined,
    assigned: first(raw.assigned) || undefined,
    archived: first(raw.archived) || undefined,
    page: first(raw.page),
  });

  let page: ContactPage | null = null;
  let assignees: ContactAssignee[] = [];
  let loadError: string | null = null;
  try {
    [page, assignees] = await Promise.all([
      listContacts(getConsoleDb(), session.actor, query),
      listContactAssignees(getConsoleDb(), session.actor),
    ]);
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Failed to load contacts';
  }

  if (loadError || !page) {
    return (
      <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>
        {loadError}
      </p>
    );
  }

  return (
    <ContactDirectory
      page={page}
      query={query}
      basePath="/my-contacts"
      title="My contacts"
      subtitle="People assigned to you, and anyone who enquired through a listing or lead of yours."
      assignees={assignees}
    />
  );
}
