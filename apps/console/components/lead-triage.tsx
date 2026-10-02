'use client';

import { useOptimistic, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { LeadAssignee, LeadKind, LeadStatus } from '@repo/core/leads';
import { useToast } from '@/components/toast';
import { assignLeadAction, setLeadStatusAction } from '@/lib/lead-actions';
import styles from './lead-table.module.css';

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  closed: 'Closed',
};

const STATUSES = Object.keys(STATUS_LABEL) as LeadStatus[];

/**
 * The status of one lead, as a control when this actor may change it.
 *
 * Whether they may is `mayUpdate`, decided by can() on the server against the
 * row's assignee — this component never looks at a role (#2). Without it the
 * badge is drawn as before, read-only.
 *
 * Optimistic, the listing table's pattern: the value moves on the click, and
 * React puts it back by itself when the transition ends if the server said no,
 * so a refusal needs no undo path — only the toast explaining why.
 */
export function LeadStatusControl({
  leadId,
  status,
  mayUpdate,
}: {
  leadId: string;
  status: LeadStatus;
  mayUpdate: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(status);

  const badge = (
    <span className={`${styles.badge} ${shown === 'new' ? styles.statusNew : styles.statusDone}`}>
      {STATUS_LABEL[shown]}
    </span>
  );
  if (!mayUpdate) return badge;

  return (
    <select
      className={`${styles.select} ${shown === 'new' ? styles.selectNew : ''}`}
      value={shown}
      disabled={pending}
      aria-label="Lead status"
      onChange={(event) => {
        const next = event.target.value as LeadStatus;
        startTransition(async () => {
          setShown(next);
          const result = await setLeadStatusAction(leadId, next);
          if (!result.ok) {
            toast({ variant: 'error', title: 'Status not changed', description: result.error });
            // A conflict means the row moved under us; show what is true now.
            if (result.code === 'conflict') router.refresh();
            return;
          }
          router.refresh();
        });
      }}
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

/**
 * Who a lead belongs to, as a picker for an actor who may assign.
 *
 * `assignees` is empty for anybody `lead:assign` refuses, and then the name is
 * shown as text. On an offer, members who could not open it are listed but
 * disabled: hiding them would read as "they left the agency", and offering them
 * would only produce a refusal from `assignLead`.
 */
export function LeadAssignControl({
  leadId,
  kind,
  assignedTo,
  assigneeName,
  assignees,
}: {
  leadId: string;
  kind: LeadKind;
  assignedTo: string | null;
  assigneeName: string | null;
  assignees: LeadAssignee[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(assignedTo);

  if (assignees.length === 0) {
    return assigneeName ? (
      <span className={styles.assignee}>{assigneeName}</span>
    ) : (
      <span className={styles.noAmount}>Unassigned</span>
    );
  }

  // A lead held by someone no longer in the list (left, suspended) still shows
  // who has it, rather than snapping silently to "Unassigned".
  const known = shown === null || assignees.some((a) => a.userId === shown);

  return (
    <select
      className={styles.select}
      value={shown ?? ''}
      disabled={pending}
      aria-label="Assigned to"
      onChange={(event) => {
        const next = event.target.value || null;
        startTransition(async () => {
          setShown(next);
          const result = await assignLeadAction(leadId, next);
          if (!result.ok) {
            toast({ variant: 'error', title: 'Not assigned', description: result.error });
            if (result.code === 'conflict') router.refresh();
            return;
          }
          router.refresh();
        });
      }}
    >
      <option value="">Unassigned</option>
      {!known ? <option value={shown ?? ''}>{assigneeName ?? 'Former member'}</option> : null}
      {assignees.map((a) => (
        <option
          key={a.userId}
          value={a.userId}
          disabled={kind === 'offer' && !a.mayTakeOffers}
        >
          {a.name}
          {kind === 'offer' && !a.mayTakeOffers ? ' (cannot see offers)' : ''}
        </option>
      ))}
    </select>
  );
}
