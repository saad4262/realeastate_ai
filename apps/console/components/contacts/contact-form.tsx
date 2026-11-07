'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ResolvedPlace } from '@repo/core/geo/schema';
import {
  addCustomerSchema,
  CONTACT_ROLE_LABELS,
  CONTACT_ROLES,
  updateContactSchema,
  type ContactRoleKind,
} from '@repo/core/contacts/schema';
// The schema entry, not the package barrel: that reaches the database client.
import { AU_STATES } from '@repo/core/listings/schema';
import { AddressAutocomplete } from '@/components/address-autocomplete';
import { useToast } from '@/components/toast';
import { createContactAction, updateContactAction } from '@/lib/contact-actions';
import { toLocalInput } from './islands';
import styles from './contacts.module.css';

export type ContactFormValues = {
  name: string;
  email: string;
  phone: string;
  /** Where they live (ADR 0079): the street part, then the place. */
  addressLine: string;
  addressSuburb: string;
  addressState: string;
  addressPostcode: string;
  /** The picker's pin; any edit to the address drops it. */
  addressLatitude: number | null;
  addressLongitude: number | null;
  roles: ContactRoleKind[];
  nextAction: string;
  /** `YYYY-MM-DDTHH:mm` in the browser's zone, as the input wants it. */
  nextActionAt: string;
  marketingConsent: boolean;
  marketingConsentNote: string;
};

export const EMPTY_CONTACT: ContactFormValues = {
  name: '',
  email: '',
  phone: '',
  addressLine: '',
  addressSuburb: '',
  addressState: '',
  addressPostcode: '',
  addressLatitude: null,
  addressLongitude: null,
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
 * the server. Adding asks for name, email, phone and address (ADR 0079); an
 * email the agency already has adds to that person's profile — blanks only —
 * and the form says so. Editing asks for none of them (an enquiry has no
 * address), and an email on another contact links to it, merging nothing.
 */
export function ContactForm({
  mode,
  contactId,
  initial = EMPTY_CONTACT,
  basePath,
  assignees = [],
  nextActionAtIso = null,
}: {
  /** The saved due instant; turned into the input's local value after mount. */
  nextActionAtIso?: string | null;
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
  useEffect(() => {
    if (nextActionAtIso) setValues((v) => ({ ...v, nextActionAt: toLocalInput(nextActionAtIso) }));
  }, [nextActionAtIso]);

  const set = <K extends keyof ContactFormValues>(key: K, value: ContactFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  /** A typed change to the address: the pin was for the address as picked, so it goes. */
  const setAddress = (partial: Partial<ContactFormValues>) =>
    setValues((v) => ({ ...v, ...partial, addressLatitude: null, addressLongitude: null }));

  function applyPlace(place: ResolvedPlace) {
    const street = [place.streetNumber, place.street].filter(Boolean).join(' ');
    const isAuState = (AU_STATES as readonly string[]).includes(place.state ?? '');
    setValues((v) => ({
      ...v,
      addressLine: place.street ? `${place.unit ? `${place.unit}/` : ''}${street}` : v.addressLine,
      addressSuburb: place.suburb ?? v.addressSuburb,
      addressState: isAuState ? (place.state as string) : v.addressState,
      addressPostcode: place.postcode ?? v.addressPostcode,
      // A suburb-only answer is not their home's pin.
      addressLatitude: place.street ? place.latitude : null,
      addressLongitude: place.street ? place.longitude : null,
    }));
  }

  const toggleRole = (role: ContactRoleKind) =>
    set('roles', values.roles.includes(role) ? values.roles.filter((r) => r !== role) : [...values.roles, role]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const { addressLatitude, addressLongitude, ...rest } = values;
    const input = {
      ...rest,
      // The picker's local time, sent as an instant.
      nextActionAt: values.nextActionAt ? new Date(values.nextActionAt).toISOString() : '',
      ...(addressLatitude !== null && addressLongitude !== null ? { addressLatitude, addressLongitude } : {}),
      ...(mode === 'create' && assignedTo ? { assignedTo } : {}),
    };
    const check = (mode === 'create' ? addCustomerSchema : updateContactSchema).safeParse(input);
    if (!check.success) {
      setError({ message: check.error.issues[0]?.message ?? 'Check the fields' });
      return;
    }
    startTransition(async () => {
      if (mode === 'edit') {
        const result = await updateContactAction(contactId as string, input);
        if (!result.ok) {
          setError({ message: result.error, ...(result.existingId ? { existingId: result.existingId } : {}) });
          return;
        }
        toast({ title: 'Saved', variant: 'success' });
        router.push(`${basePath}/${result.id}`);
        router.refresh();
        return;
      }
      const result = await createContactAction(input);
      if (!result.ok) {
        setError({ message: result.error, ...(result.existingId ? { existingId: result.existingId } : {}) });
        return;
      }
      if (result.outcome === 'created') {
        toast({ title: 'Contact added', variant: 'success' });
      } else {
        // ADR 0084: the same email is the same person — their profile takes what is new.
        const updated = result.replaced.length ? ` Updated their ${result.replaced.join(', ')} — the old value is on their timeline.` : '';
        const kept = result.offered.length ? ` Kept their ${result.offered.join(', ')} — yours is on their timeline.` : '';
        const nothing = result.filled.length || result.replaced.length || result.offered.length ? '' : 'Their profile already had all of this.';
        toast({
          title: `Already a customer: ${values.name}`,
          description: `${result.filled.length ? 'Added what their profile was missing.' : nothing}${updated}${kept}`.trim(),
          variant: 'success',
        });
        if (!result.visible) {
          // Theirs is another agent's book: the details went in, the profile stays closed to this person.
          router.push(basePath);
          router.refresh();
          return;
        }
      }
      router.push(`${basePath}/${result.id}`);
      router.refresh();
    });
  }

  // Adding asks for all four starting details (ADR 0079); editing asks for none.
  const req = mode === 'create' ? ' *' : '';

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
        <span className={styles.label}>Name{req}</span>
        <input className={styles.input} value={values.name} onChange={(e) => set('name', e.target.value)} required maxLength={120} autoComplete="off" />
      </label>

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Email{req}</span>
          <input className={styles.input} type="email" value={values.email} onChange={(e) => set('email', e.target.value)} maxLength={200} autoComplete="off" />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Phone{req}</span>
          <input className={styles.input} type="tel" value={values.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} autoComplete="off" />
        </label>
      </div>

      <fieldset className={styles.field} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: '0.75rem' }}>
        <legend className={styles.label}>Where they live{req}</legend>
        <AddressAutocomplete
          label="Find the address"
          placeholder="12 Campbell Parade, Bondi Beach"
          kinds={['address']}
          onResolved={applyPlace}
          hint={values.addressLatitude !== null ? 'Located — check the fields below.' : 'Pick a suggestion, or type the address below.'}
        />
        <label className={styles.field}>
          <span className={styles.label}>Street address{req}</span>
          <input className={styles.input} value={values.addressLine} onChange={(e) => setAddress({ addressLine: e.target.value })} maxLength={200} autoComplete="off" placeholder="3/12 Campbell Parade" />
        </label>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Suburb{req}</span>
            <input className={styles.input} value={values.addressSuburb} onChange={(e) => setAddress({ addressSuburb: e.target.value })} maxLength={120} autoComplete="off" />
          </label>
          <div className={styles.row} style={{ gap: '0.5rem' }}>
            <label className={styles.field}>
              <span className={styles.label}>State</span>
              <select className={styles.select} value={values.addressState} onChange={(e) => setAddress({ addressState: e.target.value })}>
                <option value="">—</option>
                {AU_STATES.map((st) => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Postcode{req}</span>
              <input className={styles.input} style={{ minWidth: 0 }} value={values.addressPostcode} onChange={(e) => setAddress({ addressPostcode: e.target.value })} inputMode="numeric" maxLength={4} />
            </label>
          </div>
        </div>
        <span className={styles.hint}>Their own address — it does not add a property. Link homes they own or sell from the profile.</span>
      </fieldset>

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
