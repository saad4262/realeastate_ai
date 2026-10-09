import { DeletedContacts } from '@/components/contacts/deleted-contacts';

/** My contacts deleted in the last 7 days, to restore (ADR 0025 amendment, 2026-10-09). */
export default function DeletedMyContactsPage() {
  return <DeletedContacts surface="agent" basePath="/my-contacts" />;
}
