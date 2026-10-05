'use client';

import { useOptimistic, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { assignContactAction } from '@/lib/contact-actions';
import styles from './contacts.module.css';

/**
 * Who a contact belongs to, as a picker — drawn only for an actor can() lets
 * assign (the server passes `assignees` non-empty). Optimistic, the lead
 * picker's pattern: a refusal puts the value back by itself and toasts why.
 */
export function ContactAssign({
  contactId,
  assignedTo,
  assignees,
}: {
  contactId: string;
  assignedTo: string | null;
  assignees: { userId: string; name: string }[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(assignedTo ?? '');

  return (
    <select
      className={styles.select}
      value={shown}
      disabled={pending}
      aria-label="Assigned to"
      onChange={(event) => {
        const next = event.target.value;
        startTransition(async () => {
          setShown(next);
          const result = await assignContactAction(contactId, next || null);
          if (!result.ok) toast({ title: 'Not assigned', description: result.error, variant: 'error' });
          router.refresh();
        });
      }}
    >
      <option value="">Unassigned</option>
      {assignees.map((a) => (
        <option key={a.userId} value={a.userId}>{a.name}</option>
      ))}
    </select>
  );
}
