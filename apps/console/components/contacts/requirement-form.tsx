'use client';

import { useState } from 'react';
import {
  buyerRequirementSchema,
  MAX_REQUIREMENT_NOTE,
  REQUIREMENT_CHANNEL_LABELS,
  REQUIREMENT_CHANNELS,
  type BuyerRequirementInput,
  type RequirementChannel,
  type RequirementStatus,
} from '@repo/core/contacts/schema';
import { PROPERTY_TYPES, propertyTypeLabel } from '@repo/core/listings/schema';
import {
  createRequirementAction,
  deleteRequirementAction,
  setRequirementStatusAction,
  updateRequirementAction,
} from '@/lib/contact-actions';
import { useRun } from './islands';
import styles from './contacts.module.css';

/**
 * A buyer's brief (ADR 0055): add one, change it, pause it, remove it. Drawn only when can() said
 * `contact:update` on the server (the contact's `mayUpdate`); every action asks again in core.
 * The same zod schema the server enforces runs here first, so "850k" or a minimum above the maximum
 * is refused without a round trip.
 */

/** The boxes as the agent fills them: text, so a half-typed figure is never coerced. */
export type RequirementFormValues = {
  channel: RequirementChannel;
  priceMin: string;
  priceMax: string;
  minBedrooms: string;
  minBathrooms: string;
  /** Comma-separated, as typed. */
  suburbs: string;
  propertyTypes: string[];
  note: string;
};

export const EMPTY_REQUIREMENT: RequirementFormValues = {
  channel: 'sale',
  priceMin: '',
  priceMax: '',
  minBedrooms: '',
  minBathrooms: '',
  suburbs: '',
  propertyTypes: [],
  note: '',
};

const BEDROOMS = ['1', '2', '3', '4', '5', '6'];
const BATHROOMS = ['1', '1.5', '2', '2.5', '3', '4'];

function toInput(v: RequirementFormValues, status: RequirementStatus): BuyerRequirementInput {
  return {
    channel: v.channel,
    priceMin: v.priceMin,
    priceMax: v.priceMax,
    minBedrooms: v.minBedrooms,
    minBathrooms: v.minBathrooms,
    suburbs: v.suburbs.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean),
    propertyTypes: v.propertyTypes,
    note: v.note,
    status,
  };
}

export function RequirementForm({
  contactId,
  requirementId,
  initial = EMPTY_REQUIREMENT,
  status = 'active',
  onDone,
}: {
  contactId: string;
  /** Set when editing a saved brief; absent for a new one. */
  requirementId?: string;
  initial?: RequirementFormValues;
  /** Kept as it is: pausing is its own button, not a field of the form. */
  status?: RequirementStatus;
  onDone?: () => void;
}) {
  const { pending, run } = useRun();
  const [v, setV] = useState<RequirementFormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof RequirementFormValues>(k: K, value: RequirementFormValues[K]) => setV((s) => ({ ...s, [k]: value }));
  const toggleType = (t: string) =>
    set('propertyTypes', v.propertyTypes.includes(t) ? v.propertyTypes.filter((x) => x !== t) : [...v.propertyTypes, t]);
  const perWeek = v.channel === 'rent' ? ' (per week)' : '';

  return (
    <form
      className={styles.form}
      style={{ padding: 0, maxWidth: '44rem' }}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const input = toInput(v, status);
        const check = buyerRequirementSchema.safeParse(input);
        if (!check.success) {
          setError(check.error.issues[0]?.message ?? 'Check the requirements');
          return;
        }
        setError(null);
        run(
          () => (requirementId ? updateRequirementAction(contactId, requirementId, input) : createRequirementAction(contactId, input)),
          requirementId ? 'Requirements saved' : 'Requirements added',
          () => {
            if (!requirementId) setV(EMPTY_REQUIREMENT);
            onDone?.();
          },
        );
      }}
    >
      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      <label className={styles.field}>
        <span className={styles.label}>Looking to</span>
        <select className={styles.select} value={v.channel} onChange={(e) => set('channel', e.target.value as RequirementChannel)}>
          {REQUIREMENT_CHANNELS.map((c) => (
            <option key={c} value={c}>{c === 'sale' ? 'Buy' : 'Rent'}</option>
          ))}
        </select>
      </label>

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Lowest price{perWeek}</span>
          <input className={styles.input} inputMode="numeric" value={v.priceMin} onChange={(e) => set('priceMin', e.target.value)} placeholder="Any" autoComplete="off" />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Highest price{perWeek}</span>
          <input className={styles.input} inputMode="numeric" value={v.priceMax} onChange={(e) => set('priceMax', e.target.value)} placeholder="Any" autoComplete="off" />
        </label>
      </div>

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Bedrooms, at least</span>
          <select className={styles.select} value={v.minBedrooms} onChange={(e) => set('minBedrooms', e.target.value)}>
            <option value="">Any</option>
            {BEDROOMS.map((n) => <option key={n} value={n}>{n}+</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Bathrooms, at least</span>
          <select className={styles.select} value={v.minBathrooms} onChange={(e) => set('minBathrooms', e.target.value)}>
            <option value="">Any</option>
            {BATHROOMS.map((n) => <option key={n} value={n}>{n}+</option>)}
          </select>
        </label>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>Suburbs</span>
        <input className={styles.input} value={v.suburbs} onChange={(e) => set('suburbs', e.target.value)} placeholder="e.g. Bondi Beach, Coogee, Randwick — blank for anywhere" autoComplete="off" />
        <span className={styles.hint}>Separate suburbs with commas.</span>
      </label>

      <fieldset className={styles.field} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className={styles.label}>Property type</legend>
        <div className={styles.checks}>
          {PROPERTY_TYPES.filter((t) => t !== 'other').map((t) => (
            <label key={t} className={styles.check}>
              <input type="checkbox" checked={v.propertyTypes.includes(t)} onChange={() => toggleType(t)} />
              {propertyTypeLabel(t)}
            </label>
          ))}
        </div>
        <span className={styles.hint}>None ticked means any type.</span>
      </fieldset>

      <label className={styles.field}>
        <span className={styles.label}>Anything else</span>
        <textarea className={styles.textarea} rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} maxLength={MAX_REQUIREMENT_NOTE} placeholder="e.g. Needs a yard for the dog; school catchment matters" />
        <span className={styles.hint}>For you to read — it is not used to match listings.</span>
      </label>

      <div className={styles.actions}>
        <button type="submit" className={styles.btn} disabled={pending}>
          {pending ? 'Saving…' : requirementId ? 'Save' : 'Add requirements'}
        </button>
        {onDone ? (
          <button type="button" className={styles.btnGhost} onClick={onDone}>Cancel</button>
        ) : null}
      </div>
    </form>
  );
}

/** "Add requirements" — a button that opens the form, or the form itself when there are none yet. */
export function NewRequirement({ contactId, startOpen }: { contactId: string; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  if (!open) {
    return (
      <button type="button" className={styles.btnGhost} onClick={() => setOpen(true)}>
        + Add another set of requirements
      </button>
    );
  }
  return <RequirementForm contactId={contactId} onDone={startOpen ? undefined : () => setOpen(false)} />;
}

/** Edit, pause or resume, remove — for one saved brief. */
export function RequirementControls({
  contactId,
  requirementId,
  status,
  values,
}: {
  contactId: string;
  requirementId: string;
  status: RequirementStatus;
  values: RequirementFormValues;
}) {
  const { pending, run } = useRun();
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <RequirementForm
        contactId={contactId}
        requirementId={requirementId}
        initial={values}
        status={status}
        onDone={() => setEditing(false)}
      />
    );
  }
  const next: RequirementStatus = status === 'active' ? 'paused' : 'active';
  return (
    <span className={styles.noteActions}>
      <button type="button" className={styles.linkBtn} onClick={() => setEditing(true)}>Edit</button>
      <button
        type="button"
        className={styles.linkBtn}
        disabled={pending}
        title={status === 'active' ? 'Keep it, but stop matching listings against it' : undefined}
        onClick={() => run(() => setRequirementStatusAction(contactId, requirementId, next), next === 'paused' ? 'Paused' : 'Resumed')}
      >
        {status === 'active' ? 'Pause' : 'Resume'}
      </button>
      <button
        type="button"
        className={styles.linkBtn}
        disabled={pending}
        onClick={() => {
          if (window.confirm(`Remove these ${REQUIREMENT_CHANNEL_LABELS[values.channel].toLowerCase()} requirements?`)) {
            run(() => deleteRequirementAction(contactId, requirementId), 'Requirements removed');
          }
        }}
      >
        Remove
      </button>
    </span>
  );
}
