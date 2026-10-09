import { DeletedContacts } from '@/components/contacts/deleted-contacts';

/** Contacts deleted in the last 7 days, to restore (ADR 0025 amendment, 2026-10-09). */
export default function DeletedCustomersPage() {
  return <DeletedContacts surface="agency" basePath="/customers" />;
}
