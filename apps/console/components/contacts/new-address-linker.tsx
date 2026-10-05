'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ResolvedPlace } from '@repo/core/geo/schema';
// The schema entries, not the package barrels: those reach the database
// client, and this is a client component.
import { AU_STATES } from '@repo/core/listings/schema';
import {
  CONTACT_PROPERTY_RELATION_LABELS,
  CONTACT_PROPERTY_RELATIONS,
  linkNewAddressSchema,
  type ContactPropertyRelation,
} from '@repo/core/contacts/schema';
import { AddressAutocomplete } from '@/components/address-autocomplete';
import { useToast } from '@/components/toast';
import { linkNewAddressAction } from '@/lib/contact-actions';
import styles from './contacts.module.css';

type AuState = (typeof AU_STATES)[number];

type Address = {
  unit: string;
  streetNumber: string;
  street: string;
  suburb: string;
  state: AuState;
  postcode: string;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  formattedAddress: string | null;
};

const EMPTY: Address = {
  unit: '',
  streetNumber: '',
  street: '',
  suburb: '',
  state: 'VIC',
  postcode: '',
  latitude: null,
  longitude: null,
  placeId: null,
  formattedAddress: null,
};

/**
 * Tie a contact to an address the system has never seen — an owner's or
 * vendor's home that is not listed (ADR 0018). The listing form's own address
 * picker and the same rules: pick a suggestion to fill the fields and the pin,
 * or type it; the fields stay editable, and editing one drops the picked pin
 * (the server then geocodes what was typed). Drawn only when can() lets this
 * actor edit the contact; the action checks again.
 */
export function NewAddressLinker({ contactId }: { contactId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState<Address>(EMPTY);
  const [relation, setRelation] = useState<ContactPropertyRelation>('owner');
  const [error, setError] = useState<string | null>(null);

  const edit = (partial: Partial<Address>) =>
    setAddress((prev) => ({ ...prev, ...partial, latitude: null, longitude: null, placeId: null, formattedAddress: null }));

  function applyPlace(place: ResolvedPlace) {
    const isAuState = (AU_STATES as readonly string[]).includes(place.state ?? '');
    setAddress((prev) => ({
      unit: place.unit ?? '',
      streetNumber: place.streetNumber ?? '',
      street: place.street ?? '',
      suburb: place.suburb ?? prev.suburb,
      state: isAuState ? (place.state as AuState) : prev.state,
      postcode: place.postcode ?? prev.postcode,
      // A suburb-only answer is not this home's pin; the server geocodes the street instead.
      latitude: place.street ? place.latitude : null,
      longitude: place.street ? place.longitude : null,
      placeId: place.street ? place.placeId : null,
      formattedAddress: place.street ? place.formatted || null : null,
    }));
    setError(null);
  }

  if (!open) {
    return (
      <button type="button" className={styles.linkBtn} onClick={() => setOpen(true)}>
        Not in the list? Add a new address
      </button>
    );
  }

  return (
    <form
      className={styles.form}
      style={{ padding: 0 }}
      onSubmit={(e) => {
        e.preventDefault();
        const input = {
          unit: address.unit,
          streetNumber: address.streetNumber,
          street: address.street,
          suburb: address.suburb,
          state: address.state,
          postcode: address.postcode,
          relation,
          ...(address.latitude !== null && address.longitude !== null
            ? {
                latitude: address.latitude,
                longitude: address.longitude,
                pinSource: 'google' as const,
                ...(address.placeId ? { placeId: address.placeId } : {}),
                ...(address.formattedAddress ? { formattedAddress: address.formattedAddress } : {}),
              }
            : {}),
        };
        const check = linkNewAddressSchema.safeParse(input);
        if (!check.success) {
          setError(check.error.issues[0]?.message ?? 'Check the address');
          return;
        }
        setError(null);
        startTransition(async () => {
          const result = await linkNewAddressAction(contactId, input);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast({ title: 'Address linked', variant: 'success' });
          setAddress(EMPTY);
          setOpen(false);
          router.refresh();
        });
      }}
    >
      <AddressAutocomplete
        label="Find the address"
        placeholder="12 Campbell Parade, Bondi Beach"
        kinds={['address']}
        onResolved={applyPlace}
        hint={address.latitude !== null ? 'Located — check the fields below.' : 'Pick a suggestion, or type the address below.'}
      />
      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Unit</span>
          <input className={styles.input} value={address.unit} onChange={(e) => edit({ unit: e.target.value })} maxLength={32} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Street number</span>
          <input className={styles.input} value={address.streetNumber} onChange={(e) => edit({ streetNumber: e.target.value })} maxLength={32} />
        </label>
      </div>
      <label className={styles.field}>
        <span className={styles.label}>Street *</span>
        <input className={styles.input} value={address.street} onChange={(e) => edit({ street: e.target.value })} maxLength={200} />
      </label>
      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Suburb *</span>
          <input className={styles.input} value={address.suburb} onChange={(e) => edit({ suburb: e.target.value })} maxLength={120} />
        </label>
        <div className={styles.row} style={{ gap: '0.5rem' }}>
          <label className={styles.field}>
            <span className={styles.label}>State</span>
            <select className={styles.select} value={address.state} onChange={(e) => edit({ state: e.target.value as AuState })}>
              {AU_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Postcode *</span>
            <input className={styles.input} style={{ minWidth: 0 }} value={address.postcode} onChange={(e) => edit({ postcode: e.target.value })} inputMode="numeric" maxLength={4} />
          </label>
        </div>
      </div>
      <label className={styles.field}>
        <span className={styles.label}>They are the…</span>
        <select className={styles.select} value={relation} onChange={(e) => setRelation(e.target.value as ContactPropertyRelation)}>
          {CONTACT_PROPERTY_RELATIONS.map((r) => (
            <option key={r} value={r}>{CONTACT_PROPERTY_RELATION_LABELS[r]}</option>
          ))}
        </select>
      </label>
      <p className={styles.hint}>
        Adding a home here publishes nothing — it only becomes public if it is ever listed.
      </p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <button type="submit" className={styles.btn} disabled={pending}>
          {pending ? 'Adding…' : 'Add and link'}
        </button>
        <button type="button" className={styles.btnGhost} onClick={() => { setOpen(false); setError(null); }}>
          Cancel
        </button>
      </div>
    </form>
  );
}
