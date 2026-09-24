'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
// The schema entry, not the package barrel: the barrel reaches the database
// client, and this is a client component.
import {
  AU_STATES,
  createListingInputSchema,
  PROPERTY_TYPES,
  propertyTypeLabel,
  listingFieldErrors,
  updateListingInputSchema,
  type ListingChannel,
  type ListingFieldErrors,
  type ListingForEdit,
} from '@repo/core/listings/schema';
import type { ResolvedPlace } from '@repo/core/geo/schema';
import { createListingAction, updateListingAction } from '@/lib/listing-actions';
import { AddressAutocomplete } from '@/components/address-autocomplete';
import { PinField } from '@/components/pin-field';
import { useToast } from '@/components/toast';
import styles from './listing-form.module.css';

const CHANNELS: { id: ListingChannel; label: string }[] = [
  { id: 'sale', label: 'For sale' },
  { id: 'rent', label: 'For rent' },
];

/** Blank strings must not reach the schema as "" where a number is expected. */
function opt(value: string): string | undefined {
  const v = value.trim();
  return v === '' ? undefined : v;
}

/**
 * The address half of the form, which the autocomplete writes into.
 *
 * Held as state rather than read off the DOM because picking a suggestion has
 * to fill six fields at once, and coordinates have no input of their own.
 */
type AddressState = {
  unit: string;
  streetNumber: string;
  street: string;
  suburb: string;
  state: string;
  postcode: string;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  /** The geocoder's own line for the pin, shown back so a wrong pin is visible. */
  formattedAddress: string | null;
  /** Who put the pin there. 'manual' outranks the geocoder and is never moved. */
  pinSource: 'google' | 'manual' | null;
};

const BLANK_ADDRESS: AddressState = {
  unit: '',
  streetNumber: '',
  street: '',
  suburb: '',
  state: 'NSW',
  postcode: '',
  latitude: null,
  longitude: null,
  placeId: null,
  pinSource: null,
  formattedAddress: null,
};

function addressFrom(initial: ListingForEdit | null): AddressState {
  if (!initial) return BLANK_ADDRESS;
  const p = initial.property;
  return {
    unit: p.unit ?? '',
    streetNumber: p.streetNumber ?? '',
    street: p.street ?? '',
    suburb: p.suburb,
    state: p.state,
    postcode: p.postcode,
    latitude: p.latitude,
    longitude: p.longitude,
    placeId: p.placeId,
    pinSource: p.geocodeSource === 'manual' ? 'manual' : p.geocodeSource ? 'google' : null,
    formattedAddress: p.formattedAddress,
  };
}

/**
 * One form, both surfaces, both modes.
 *
 * The agency console and the agent desk post the same contract to the same
 * pair of actions; the only difference is where they land afterwards.
 * Duplicating this per route group is how the two drift apart, and a create
 * form and an edit form that are separate components is how a field ends up
 * saveable in one and not the other.
 */
export function ListingForm({
  backHref,
  initial = null,
}: {
  backHref: string;
  /** Present means edit. Absent means create. */
  initial?: ListingForEdit | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const editing = initial !== null;

  const [channel, setChannel] = useState<ListingChannel>(initial?.listing.channel ?? 'sale');
  const [address, setAddress] = useState<AddressState>(() => addressFrom(initial));
  const [errors, setErrors] = useState<ListingFieldErrors>({});
  /**
   * Where the chosen suburb is.
   *
   * Not a pin — a suburb centroid is not the house — but it is where the map
   * should open, so an agent who picked Pakenham is not dropped in Sydney and
   * left to scroll across a state.
   */
  const [suburbCentre, setSuburbCentre] = useState<{ lat: number; lng: number } | null>(null);
  /**
   * The navigation after a successful save is part of the same transition, so
   * the button stays disabled until the next page is actually ready instead of
   * re-enabling for the gap in between and inviting a second submit.
   */
  const [busy, startSaving] = useTransition();

  function invalid(key: string) {
    return errors[key] ? `${styles.input} ${styles.invalid}` : styles.input;
  }

  function Err({ name }: { name: string }) {
    return errors[name] ? (
      <p className={styles.error} role="alert">
        {errors[name]}
      </p>
    ) : null;
  }

  function patchAddress(partial: Partial<AddressState>) {
    setAddress((prev) => ({ ...prev, ...partial }));
  }

  /**
   * A field edited by hand invalidates the pin.
   *
   * Changing the street number after picking a suggestion would otherwise save
   * one address with another address's coordinates, and it would look right on
   * screen while putting the property on the wrong part of the map.
   */
  function editAddressField(partial: Partial<AddressState>) {
    setAddress((prev) => ({
      ...prev,
      ...partial,
      // A pin a person placed survives an address edit. They put it on the
      // property; correcting a misspelled street does not make it wrong, and
      // silently discarding it would undo the one thing they did by hand.
      ...(prev.pinSource === 'manual'
        ? {}
        : { latitude: null, longitude: null, placeId: null, formattedAddress: null }),
    }));
  }

  /**
   * A suburb chosen from the dropdown.
   *
   * Fills suburb, state and postcode together, in the order they are written
   * on an envelope — Pakenham, VIC 3810. Typing them separately is how a
   * listing ends up in "Pakenham NSW 3810", which matches no search anyone
   * will ever run.
   *
   * The street-level pin is dropped: it belonged to a different address, and a
   * suburb centroid is not a substitute for it. The server geocodes the full
   * address on save.
   */
  function applySuburb(place: ResolvedPlace) {
    setSuburbCentre({ lat: place.latitude, lng: place.longitude });
    const isAuState = (AU_STATES as readonly string[]).includes(place.state ?? '');
    setAddress((prev) => ({
      ...prev,
      suburb: place.suburb ?? prev.suburb,
      state: isAuState ? (place.state as string) : prev.state,
      postcode: place.postcode ?? prev.postcode,
      // Suburb and pin are separate things. Choosing a suburb says nothing
      // about where in it the house is, so a pin already placed stays; a
      // suburb centroid would be a worse answer than no pin at all.
      ...(prev.pinSource === 'manual'
        ? {}
        : { latitude: null, longitude: null, placeId: null, formattedAddress: null }),
    }));
    setErrors(({ suburb: _s, postcode: _p, ...rest }) => rest);
  }

  /**
   * A street address chosen from the dropdown.
   *
   * Both halves are kept, because both are searched on: the exact point the
   * provider pinned, and the suburb a buyer types. Neither replaces the other
   * — a pin answers "within 5 km of here" and the suburb answers "Pakenham",
   * and a listing needs to be findable by both.
   *
   * A result carrying no street is a suburb or a region, whatever was typed:
   * Google answers an unrecognised line with the centroid of the state. Taking
   * that as an address would blank the street fields on screen and pin the
   * property hundreds of kilometres away, so it is handled as the suburb it is.
   */
  function applyPlace(place: ResolvedPlace) {
    if (!place.street) {
      applySuburb(place);
      return;
    }
    const isAuState = (AU_STATES as readonly string[]).includes(place.state ?? '');
    setAddress((prev) => ({
      unit: place.unit ?? prev.unit,
      streetNumber: place.streetNumber ?? '',
      street: place.street ?? '',
      suburb: place.suburb ?? prev.suburb,
      state: isAuState ? (place.state as string) : prev.state,
      postcode: place.postcode ?? prev.postcode,
      latitude: place.latitude,
      longitude: place.longitude,
      placeId: place.placeId,
      formattedAddress: place.formatted || null,
      pinSource: 'google',
    }));
    // The picker filled these in, so any complaint about them is stale.
    setErrors(({ suburb: _s, postcode: _p, ...rest }) => rest);
  }

  /**
   * The agent moved the pin.
   *
   * This is a claim by someone who can see the property, so it is recorded as
   * one: the server stops re-geocoding over it, and `geo:backfill` leaves it
   * alone. The place id and the geocoder's line are dropped with it — this is
   * now a point on a map, not one of Google's addresses, and keeping them
   * would say this spot is that address when the agent has just said it is not.
   */
  function movePin(lat: number, lng: number) {
    setAddress((prev) => ({
      ...prev,
      latitude: lat,
      longitude: lng,
      placeId: null,
      formattedAddress: null,
      pinSource: 'manual',
    }));
  }

  /** Back to the geocoder's answer. Only offered when there is one to go back to. */
  function resetPin() {
    const p = initial?.property;
    setAddress((prev) => ({
      ...prev,
      latitude: p?.latitude ?? null,
      longitude: p?.longitude ?? null,
      placeId: p?.placeId ?? null,
      formattedAddress: p?.formattedAddress ?? null,
      pinSource: p?.geocodeSource === 'manual' ? 'manual' : p?.latitude != null ? 'google' : null,
    }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const get = (k: string) => String(data.get(k) ?? '');

    const input = {
      property: {
        unit: opt(address.unit),
        streetNumber: opt(address.streetNumber),
        street: opt(address.street),
        suburb: address.suburb,
        state: address.state,
        postcode: address.postcode,
        propertyType: opt(get('propertyType')),
        bedrooms: opt(get('bedrooms')),
        bathrooms: opt(get('bathrooms')),
        carSpaces: opt(get('carSpaces')),
        landAreaSqm: opt(get('landAreaSqm')),
        // Only sent when the picker actually resolved this exact address, so
        // the server geocodes a hand-typed one instead of trusting a stale pin.
        latitude: address.latitude ?? undefined,
        longitude: address.longitude ?? undefined,
        placeId: address.placeId ?? undefined,
        pinSource: address.pinSource ?? undefined,
        formattedAddress: address.formattedAddress ?? undefined,
      },
      listing: {
        channel,
        headline: get('headline'),
        description: opt(get('description')),
        priceDisplay: opt(get('priceDisplay')),
        priceFrom: opt(get('priceFrom')),
        priceTo: opt(get('priceTo')),
        rentPw: opt(get('rentPw')),
      },
      ...(editing ? {} : { agentUserIds: [] }),
    };

    // Same contract the server enforces, so a bad draft never needs a round
    // trip to come back as an error.
    const schema = editing ? updateListingInputSchema : createListingInputSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const fieldErrors = listingFieldErrors(parsed.error.issues);
      // Paths arrive as property.suburb / listing.priceTo; the inputs are named
      // by their leaf, so flatten before showing them.
      const flat: ListingFieldErrors = {};
      for (const [key, message] of Object.entries(fieldErrors)) {
        flat[key.split('.').pop() ?? key] = message;
      }
      setErrors(flat);
      toast({
        variant: 'warning',
        title: 'Check the highlighted fields',
        description: Object.values(flat)[0],
      });
      return;
    }

    setErrors({});

    startSaving(async () => {
      const result = editing
        ? await updateListingAction(initial.id, parsed.data)
        : await createListingAction(parsed.data);

      if (!result.ok) {
        if ('field' in result && result.field) {
          setErrors({ [result.field.split('.').pop() ?? result.field]: result.error });
        }
        toast({
          variant: 'error',
          title: editing ? 'Changes not saved' : 'Listing not saved',
          description: result.error,
        });
        return;
      }

      toast({
        variant: 'success',
        title: editing ? 'Listing updated' : 'Listing saved as a draft',
        description: editing
          ? // Deliberately reassuring: the commonest fear when editing a live ad
            // is that saving takes it down. Status is not something this form
            // can change at all.
            'Its status is unchanged — publishing stays a separate step.'
          : 'Nothing is public until you publish it.',
      });
      router.push(backHref);
      router.refresh();
    });
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Listing type</h2>
        <p className={styles.sectionHint}>
          Sale or rental decides which price fields apply.
        </p>
        <div className={styles.channels}>
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={
                channel === c.id ? `${styles.channel} ${styles.channelActive}` : styles.channel
              }
              aria-pressed={channel === c.id}
              onClick={() => setChannel(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>The property</h2>
        <p className={styles.sectionHint}>
          The physical place, kept separate from the ad. If this address already exists it is
          reused, so its history stays in one place.
        </p>

        <div className={styles.wide} style={{ marginBottom: '0.875rem' }}>
          <AddressAutocomplete
            label="Find the address or suburb"
            placeholder="12 Campbell Parade — or just Pakenham"
            // Deliberately unrestricted. Asking Google for street addresses
            // only meant typing "paken" returned nothing at all, which reads as
            // a broken box rather than as "that is not a street". Agents start
            // with whatever they have, and half the time that is the suburb.
            // applyPlace routes a street-less result to the suburb handler, so
            // both answers land in the right fields.
            kinds={undefined}
            // The line the geocoder pinned when there is one, so reopening the
            // form shows what was located rather than what was typed.
            defaultValue={initial?.property.formattedAddress ?? initial?.address ?? ''}
            hint={
              address.latitude !== null
                ? // The pinned line, not just the fact of a pin: an agent who
                  // picked the Manly Vale Campbell Parade instead of the Bondi
                  // one can only see it here.
                  `Pinned: ${address.formattedAddress ?? 'this address'} — it will appear in distance searches.`
                : 'Optional. A full address fills every field and drops the pin; a suburb fills suburb, state and postcode. Type it by hand below if it is not found.'
            }
            onResolved={applyPlace}
          />
        </div>

        <div className={styles.grid}>
          <div className={styles.field}>
            <label htmlFor="unit">Unit</label>
            <input
              id="unit"
              className={invalid('unit')}
              placeholder="3"
              value={address.unit}
              onChange={(e) => editAddressField({ unit: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="streetNumber">Street number</label>
            <input
              id="streetNumber"
              className={invalid('streetNumber')}
              placeholder="12"
              value={address.streetNumber}
              onChange={(e) => editAddressField({ streetNumber: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="street">Street</label>
            <input
              id="street"
              className={invalid('street')}
              placeholder="Campbell Parade"
              value={address.street}
              onChange={(e) => editAddressField({ street: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            {/*
              A picker, not a text box. A mistyped suburb is invisible — the
              listing saves, looks right in the console, and silently matches
              no buyer search. Free text still works for a new estate the
              gazetteer has not caught up with.
            */}
            <AddressAutocomplete
              label="Suburb *"
              placeholder="Pakenham"
              kinds={['locality']}
              value={address.suburb}
              onChange={(v) => editAddressField({ suburb: v })}
              onResolved={applySuburb}
              // Shown back in the order it will be searched and printed, so a
              // wrong state or postcode is visible before the listing is saved
              // rather than after a buyer fails to find it.
              hint={
                address.suburb
                  ? `${address.suburb}, ${address.state}${address.postcode ? ` ${address.postcode}` : ''}`
                  : undefined
              }
            />
            <Err name="suburb" />
          </div>
          <div className={styles.field}>
            <label htmlFor="state">State *</label>
            <select
              id="state"
              className={styles.select}
              value={address.state}
              onChange={(e) => patchAddress({ state: e.target.value })}
            >
              {AU_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="postcode">Postcode *</label>
            {/* Filled by the suburb picker above; editable for the same reason
                the suburb is. */}
            <input
              id="postcode"
              required
              inputMode="numeric"
              className={invalid('postcode')}
              placeholder="2026"
              aria-invalid={Boolean(errors.postcode)}
              value={address.postcode}
              onChange={(e) => editAddressField({ postcode: e.target.value })}
            />
            <Err name="postcode" />
          </div>
          <div className={styles.field}>
            <label htmlFor="propertyType">Type</label>
            {/*
              A list, not a text box. This was free text, and the public search
              filters on this column and builds its dropdown from the distinct
              values in it — so "sfd" typed once became a property type a buyer
              could filter by forever, and "House" and "house" were two
              different kinds of building. PROPERTY_TYPES is the one list.
            */}
            <select
              id="propertyType"
              name="propertyType"
              className={invalid('propertyType')}
              defaultValue={initial?.property.propertyType?.toLowerCase() ?? ''}
            >
              <option value="">Not specified</option>
              {PROPERTY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {propertyTypeLabel(t)}
                </option>
              ))}
            </select>
            <Err name="propertyType" />
          </div>
          <div className={styles.field}>
            <label htmlFor="bedrooms">Bedrooms</label>
            <input
              id="bedrooms"
              name="bedrooms"
              inputMode="numeric"
              className={invalid('bedrooms')}
              placeholder="3"
              defaultValue={initial?.property.bedrooms ?? ''}
            />
            <Err name="bedrooms" />
          </div>
          <div className={styles.field}>
            <label htmlFor="bathrooms">Bathrooms</label>
            <input
              id="bathrooms"
              name="bathrooms"
              inputMode="decimal"
              className={invalid('bathrooms')}
              placeholder="2"
              defaultValue={initial?.property.bathrooms ?? ''}
            />
            <Err name="bathrooms" />
          </div>
          <div className={styles.field}>
            <label htmlFor="carSpaces">Car spaces</label>
            <input
              id="carSpaces"
              name="carSpaces"
              inputMode="numeric"
              className={invalid('carSpaces')}
              placeholder="1"
              defaultValue={initial?.property.carSpaces ?? ''}
            />
            <Err name="carSpaces" />
          </div>
          <div className={styles.field}>
            <label htmlFor="landAreaSqm">Land (m²)</label>
            <input
              id="landAreaSqm"
              name="landAreaSqm"
              inputMode="decimal"
              className={invalid('landAreaSqm')}
              placeholder="420"
              defaultValue={initial?.property.landAreaSqm ?? ''}
            />
            <Err name="landAreaSqm" />
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Where it is on the map</h2>
        <p className={styles.sectionHint}>
          Separate from the address above. The address is what buyers read and what a suburb
          search matches; the pin is what a map shows and what a &ldquo;within 5 km&rdquo;
          search measures. They usually agree — when they do not, you are standing in the
          property and the geocoder is not.
        </p>
        <PinField
          pin={{
            latitude: address.latitude,
            longitude: address.longitude,
            source: address.pinSource,
            formattedAddress: address.formattedAddress,
          }}
          onMove={movePin}
          // Typing an address in the map's own box does exactly what typing it
          // at the top of the form does. One behaviour, two ways in.
          onAddressPicked={applyPlace}
          onAdoptAddress={applyPlace}
          fallbackCentre={suburbCentre}
          // Only offered on an edit, and only when the saved row has a pin to
          // go back to. On a new listing there is no earlier answer to restore.
          onReset={initial?.property.latitude != null ? resetPin : undefined}
          label={address.suburb || undefined}
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>The advertisement</h2>
        <p className={styles.sectionHint}>
          The price shown to buyers and the numbers used for filtering are stored separately —
          write the copy you want, and give the range you want it to match on.
        </p>
        <div className={styles.grid}>
          <div className={`${styles.field} ${styles.wide}`}>
            <label htmlFor="headline">Headline *</label>
            <input
              id="headline"
              name="headline"
              required
              className={invalid('headline')}
              placeholder="Beachfront three bedder with district views"
              aria-invalid={Boolean(errors.headline)}
              defaultValue={initial?.listing.headline ?? ''}
            />
            <Err name="headline" />
          </div>

          {channel === 'rent' ? (
            <div className={styles.field}>
              <label htmlFor="rentPw">Rent per week ($) *</label>
              <input
                id="rentPw"
                name="rentPw"
                inputMode="decimal"
                className={invalid('rentPw')}
                placeholder="1500"
                aria-invalid={Boolean(errors.rentPw)}
                defaultValue={initial?.listing.rentPw ?? ''}
              />
              <Err name="rentPw" />
            </div>
          ) : (
            <>
              <div className={styles.field}>
                <label htmlFor="priceDisplay">Price text (public)</label>
                <input
                  id="priceDisplay"
                  name="priceDisplay"
                  className={invalid('priceDisplay')}
                  placeholder="Offers over $2.4M"
                  defaultValue={initial?.listing.priceDisplay ?? ''}
                />
                <Err name="priceDisplay" />
              </div>
              <div className={styles.field}>
                <label htmlFor="priceFrom">Search from ($)</label>
                <input
                  id="priceFrom"
                  name="priceFrom"
                  inputMode="decimal"
                  className={invalid('priceFrom')}
                  placeholder="2400000"
                  defaultValue={initial?.listing.priceFrom ?? ''}
                />
                <Err name="priceFrom" />
              </div>
              <div className={styles.field}>
                <label htmlFor="priceTo">Search to ($)</label>
                <input
                  id="priceTo"
                  name="priceTo"
                  inputMode="decimal"
                  className={invalid('priceTo')}
                  placeholder="2600000"
                  aria-invalid={Boolean(errors.priceTo)}
                  defaultValue={initial?.listing.priceTo ?? ''}
                />
                <Err name="priceTo" />
              </div>
            </>
          )}

          <div className={`${styles.field} ${styles.wide}`}>
            <label htmlFor="description">Description</label>
            <textarea
              id="description"
              name="description"
              className={styles.textarea}
              placeholder="What a buyer should know about this home."
              defaultValue={initial?.listing.description ?? ''}
            />
          </div>
        </div>
      </section>

      <div className={styles.footer}>
        <button type="submit" className={styles.submit} disabled={busy}>
          <span className={styles.glyph} aria-hidden>
            save
          </span>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Save as draft'}
        </button>
        <button type="button" className={styles.ghost} onClick={() => router.push(backHref)}>
          Cancel
        </button>
        <p className={styles.note}>
          {editing
            ? 'Editing never changes whether a listing is public. Publish and withdraw stay on the listings table.'
            : 'Saved listings start as drafts. Nothing reaches the public site until you publish it.'}
        </p>
      </div>
    </form>
  );
}
