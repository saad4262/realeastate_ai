'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CONTACT_ROLE_LABELS,
  CONTACT_ROLES,
  createContactSchema,
  updateContactSchema,
  type ContactRoleKind,
} from '@repo/core/contacts/schema';
import { useToast } from '@/components/toast';
import { createContactAction, updateContactAction } from '@/lib/contact-actions';
import styles from './contacts.module.css';

export type ContactFormValues = {
  name: string;
  email: string;
  phone: string;
  roles: ContactRoleKind[];
  nextAction: string;
  /** `YYYY-MM-DDTHH:mm`, local, as the input wants it. */
  nextActionAt: string;
  marketingConsent: boolean;
  marketingConsentNote: string;
};

export const EMPTY_CONTACT: ContactFormValues = {
  name: '',
  email: '',
  phone: '',
  roles: [],
  nextAction: '',
  nextActionAt: '',
  marketingConsent: false,
  marketingConsentNote: '',
};

/**
 * Add or edit a contact. The same zod schema the server enforces runs here
 * first, so a missing name is refused without a round trip; the action checks
 * again, and can() decides inside it — this form never sees a role (#2).
 *
 * Whether an assignee picker is drawn (`assignees`) was decided by can() on
 * the server. An email already on another contact comes back with that
 * contact's id, and the form links to it instead of merging anything.
 */
export function ContactForm({
  mode,
  contactId,
  initial = EMPTY_CONTACT,
  basePath,
  assignees = [],
}: {
  mode: 'create' | 'edit';
  contactId?: string;
  initial?: ContactFormValues;
  basePath: string;
  /** Members a new contact may be given to. Empty unless this actor may assign. */
  assignees?: { userId: string; name: string }[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState(initial);
  const [assignedTo, setAssignedTo] = useState('');
  const [error, setError] = useState<{ message: string; existingId?: string } | null>(null);

  const set = <K extends keyof ContactFormValues>(key: K, value: ContactFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const toggleRole = (role: ContactRoleKind) =>
    set('roles', values.roles.includes(role) ? values.roles.filter((r) => r !== role) : [...values.roles, role]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const input = {
      ...values,
      // The picker's local time, sent as an instant.
      nextActionAt: values.nextActionAt ? new Date(values.nextActionAt).toISOString() : '',
      ...(mode === 'create' && assignedTo ? { assignedTo } : {}),
    };
    const check = (mode === 'create' ? createContactSchema : updateContactSchema).safeParse(input);
    if (!check.success) {
      setError({ message: check.error.issues[0]?.message ?? 'Check the fields' });
      return;
    }
    startTransition(async () => {
      const result =
        mode === 'create'
          ? await createContactAction(input)
          : await updateContactAction(contactId as string, input);
      if (!result.ok) {
        setError({ message: result.error, ...(result.existingId ? { existingId: result.existingId } : {}) });
        return;
      }
      toast({ title: mode === 'create' ? 'Contact added' : 'Saved', variant: 'success' });
      router.push(`${basePath}/${result.id}`);
      router.refresh();
    });
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {error ? (
        <p className={styles.error} role="alert">
          {error.message}
          {error.existingId ? (
            <> — <Link href={`${basePath}/${error.existingId}`}>open that contact</Link></>
          ) : null}
        </p>
      ) : null}

      <label className={styles.field}>
        <span className={styles.label}>Name</span>
        <input className={styles.input} value={values.name} onChange={(e) => set('name', e.target.value)} required maxLength={120} autoComplete="off" />
      </label>

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Email</span>
          <input className={styles.input} type="email" value={values.email} onChange={(e) => set('email', e.target.value)} maxLength={200} autoComplete="off" />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Phone</span>
          <input className={styles.input} type="tel" value={values.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} autoComplete="off" />
        </label>
      </div>

      <fieldset className={styles.field} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className={styles.label}>Roles</legend>
        <div className={styles.checks}>
          {CONTACT_ROLES.map((r) => (
            <label key={r} className={styles.check}>
              <input type="checkbox" checked={values.roles.includes(r)} onChange={() => toggleRole(r)} />
              {CONTACT_ROLE_LABELS[r]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Next action</span>
          <input className={styles.input} value={values.nextAction} onChange={(e) => set('nextAction', e.target.value)} maxLength={300} placeholder="e.g. Call about the appraisal" />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Due</span>
          <input className={styles.input} type="datetime-local" value={values.nextActionAt} onChange={(e) => set('nextActionAt', e.target.value)} />
        </label>
      </div>

      <div className={styles.field}>
        <label className={styles.check}>
          <input type="checkbox" checked={values.marketingConsent} onChange={(e) => set('marketingConsent', e.target.checked)} />
          <span className={styles.label}>Has agreed to receive marketing email</span>
        </label>
        <span className={styles.hint}>
          Tick only when they have said yes. An enquiry is not consent. We record who ticked it and when.
        </span>
        {values.marketingConsent ? (
          <input className={styles.input} value={values.marketingConsentNote} onChange={(e) => set('marketingConsentNote', e.target.value)} maxLength={300} placeholder="How they agreed, e.g. 'Asked at the open home, 4 Oct'" />
        ) : null}
      </div>

      {mode === 'create' && assignees.length ? (
        <label className={styles.field}>
          <span className={styles.label}>Assign to</span>
          <select className={styles.select} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
            <option value="">Nobody yet</option>
            {assignees.map((a) => (
              <option key={a.userId} value={a.userId}>{a.name}</option>
            ))}
          </select>
        </label>
      ) : null}

      <div className={styles.actions}>
        <button type="submit" className={styles.btn} disabled={pending}>
          {pending ? 'Saving…' : mode === 'create' ? 'Add contact' : 'Save'}
        </button>
        <Link href={mode === 'create' ? basePath : `${basePath}/${contactId}`} className={styles.btnGhost}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
