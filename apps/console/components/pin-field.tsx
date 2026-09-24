'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

/**
 * The pin map is behind a toggle and starts closed, so its code has no business
 * in the listing form's first load. ssr: false because it needs `window`.
 */
const MapView = dynamic(() => import('@repo/ui/maps').then((m) => m.MapView), {
  ssr: false,
});
import type { ResolvedPlace } from '@repo/core/geo/schema';
import { reverseGeocodeAction } from '@/lib/listing-actions';
import { AddressAutocomplete } from '@/components/address-autocomplete';
import styles from './pin-field.module.css';

export type PinState = {
  latitude: number | null;
  longitude: number | null;
  /** 'google' when the geocoder placed it, 'manual' when a person dragged it. */
  source: 'google' | 'manual' | null;
  /** The one-line address for wherever the pin currently is. */
  formattedAddress: string | null;
};

type Props = {
  pin: PinState;
  /** Called with the new position whenever the marker is dragged or the map clicked. */
  onMove: (lat: number, lng: number) => void;
  /** A typed address was picked: move the pin there and fill the form. */
  onAddressPicked: (place: ResolvedPlace) => void;
  /**
   * The pin was dragged and the geocoder named where it landed. Offered to the
   * form so the agent can adopt it, never applied behind their back.
   */
  onAdoptAddress: (place: ResolvedPlace) => void;
  /** Puts the geocoder's pin back. Absent when there is nothing to go back to. */
  onReset?: () => void;
  /** Where to open the map when there is no pin yet. */
  fallbackCentre?: { lat: number; lng: number } | null;
  label?: string;
};

/**
 * The map pin, as its own field, with an address box of its own.
 *
 * Two ways in, because agents split into two habits and both are reasonable:
 * type the address and let the pin follow, or drag the pin and be told what is
 * there. Offering only one means the other half of the office fights the form.
 *
 * Kept separate from the address fields above on purpose. The address is what
 * gets printed on the ad and what a suburb search matches; the pin is what a
 * map shows and what a radius search measures. They are usually the same place,
 * and the times they are not are the times this matters: a geocoder one street
 * out on a new subdivision, or a battleaxe block whose street address points at
 * the front house's driveway. The agent is standing in the property. The
 * geocoder is not.
 */
export function PinField({
  pin,
  onMove,
  onAddressPicked,
  onAdoptAddress,
  onReset,
  fallbackCentre,
  label,
}: Props) {
  const [open, setOpen] = useState(false);
  /**
   * Where to look when there is no pin.
   *
   * Set by choosing a suburb in the box below: that is not a pin — a suburb
   * centroid is not where the house is — but it is a place to look while
   * dropping one by hand.
   */
  const [lookingAt, setLookingAt] = useState<{ lat: number; lng: number } | null>(null);
  /** What the geocoder says is at the current pin, once it has been asked. */
  const [atPin, setAtPin] = useState<ResolvedPlace | null>(null);
  const [looking, setLooking] = useState(false);

  const has = pin.latitude !== null && pin.longitude !== null;
  const manual = pin.source === 'manual';

  /**
   * Ask the geocoder what is at the pin, but only for a pin a person placed.
   *
   * A pin that came from an address already has its address — asking again
   * would be a second bill for an answer on screen. The key is the rounded
   * position, so a marker nudged by a pixel is not a fresh lookup.
   */
  const lastAsked = useRef<string | null>(null);

  useEffect(() => {
    if (!open || !manual || pin.latitude === null || pin.longitude === null) return;

    const key = `${pin.latitude.toFixed(5)},${pin.longitude.toFixed(5)}`;
    if (lastAsked.current === key) return;
    lastAsked.current = key;

    let cancelled = false;
    // A short wait so dragging the marker across the map is one lookup, not
    // one per frame of the drag's final settle.
    const timer = setTimeout(async () => {
      setLooking(true);
      try {
        const place = await reverseGeocodeAction(pin.latitude as number, pin.longitude as number);
        if (!cancelled) setAtPin(place);
      } catch {
        if (!cancelled) setAtPin(null);
      } finally {
        if (!cancelled) setLooking(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, manual, pin.latitude, pin.longitude]);

  const pins = has
    ? [{ id: 'listing', lat: pin.latitude as number, lng: pin.longitude as number, label }]
    : [];

  /** What to show as the address of the current pin. */
  const pinAddress = manual ? atPin?.formatted ?? null : pin.formattedAddress;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <div className={styles.label}>Map pin</div>
          <p className={styles.status}>
            {!has ? (
              <>
                <span className={styles.dotNone} aria-hidden /> Not placed — this listing will
                not appear in distance searches or on a map.
              </>
            ) : manual ? (
              <>
                <span className={styles.dotManual} aria-hidden /> Placed by hand. Nothing will
                move it.
              </>
            ) : (
              <>
                <span className={styles.dotAuto} aria-hidden /> Found from the address
              </>
            )}
          </p>
        </div>

        <button type="button" className={styles.toggle} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide map' : has ? 'Check or move the pin' : 'Place the pin'}
        </button>
      </div>

      {open ? (
        <>
          {/*
            Type an address and the pin follows. The same control as the one at
            the top of the form, deliberately repeated here: an agent working on
            the map should not have to scroll back up to correct the address,
            and one who never opens the map should not have to.
          */}
          <AddressAutocomplete
            label="Find an address or suburb"
            placeholder="12 Campbell Parade — or just Pakenham"
            // Unrestricted, like the box at the top of the form. Restricting
            // this to street addresses meant typing a suburb returned nothing,
            // which is the state an agent is in precisely when they most need
            // the map: they cannot find the address, so they want to go to the
            // suburb and drop the pin themselves.
            kinds={undefined}
            defaultValue={pinAddress ?? ''}
            onResolved={(place) => {
              if (place.street) {
                // A real address: move the pin and fill the form.
                onAddressPicked(place);
              } else {
                // A suburb: take them there, but do not pretend its centroid
                // is the property. The pin stays unplaced until they place it.
                setLookingAt({ lat: place.latitude, lng: place.longitude });
              }
            }}
            hint="An address moves the pin to it. A suburb just takes the map there, so you can drop the pin yourself."
          />

          <MapView
            pins={pins}
            onPinMove={onMove}
            centre={lookingAt ?? fallbackCentre ?? undefined}
            height={340}
            hint="Drag the marker, or click anywhere on the map, to put the pin on the property. Satellite view is on so you can find the roof line."
          />

          <div className={styles.readout}>
            <span className={styles.coords}>
              {has
                ? `${(pin.latitude as number).toFixed(6)}, ${(pin.longitude as number).toFixed(6)}`
                : 'No pin yet'}
            </span>

            {looking ? (
              <span className={styles.atPin}>Looking up this spot…</span>
            ) : pinAddress ? (
              <span className={styles.atPin}>
                {manual ? 'Nearest address: ' : ''}
                {pinAddress}
              </span>
            ) : manual && has ? (
              <span className={styles.atPin}>No address found at this spot.</span>
            ) : null}
          </div>

          <div className={styles.actions}>
            {/*
              Offered, not applied. The agent may have dragged the pin to the
              back of a battleaxe block on purpose, in which case the nearest
              address is the front house's and overwriting theirs would be wrong.
            */}
            {manual && atPin?.street ? (
              <button
                type="button"
                className={styles.adopt}
                onClick={() => onAdoptAddress(atPin)}
              >
                Use this as the listing address
              </button>
            ) : null}

            {manual && onReset ? (
              <button type="button" className={styles.reset} onClick={onReset}>
                Put it back where the address says
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
