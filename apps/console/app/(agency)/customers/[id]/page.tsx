import { redirect } from 'next/navigation';
import {
  ContactError,
  getContact,
  listContactAssignees,
  type ContactAssignee,
} from '@repo/core/contacts';
import { ContactProfile } from '@/components/contacts/contact-profile';
import { getConsoleDb } from '../../../../lib/db';
import { requireConsoleAccess } from '../../../../lib/require-console-access';

/**
 * One contact. A contact this actor may not see answers exactly like one that
 * does not exist, so ids cannot be probed. A merged contact sends you on to
 * the one it was merged into.
 */
export default async function ContactPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess('agency');
  const { id } = await params;
  const editing = (await searchParams).edit === '1';

  let view: Awaited<ReturnType<typeof getContact>> | null = null;
  let assignees: ContactAssignee[] = [];
  let loadError: string | null = null;
  try {
    [view, assignees] = await Promise.all([
      getContact(getConsoleDb(), session.actor, id),
      listContactAssignees(getConsoleDb(), session.actor),
    ]);
  } catch (err) {
    loadError = err instanceof ContactError ? err.message : 'Failed to load the contact';
  }

  if (view && 'mergedInto' in view) redirect(`/customers/${view.mergedInto}`);
  if (loadError || !view) {
    return (
      <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>
        {loadError}
      </p>
    );
  }

  return <ContactProfile contact={view} basePath="/customers" editing={editing} assignees={assignees} />;
}
