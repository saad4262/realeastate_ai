'use client';

import { useEffect, useRef, useState } from 'react';
import { loadGoogleMaps, mapsBrowserKey } from './loader';
import styles from './map-view.module.css';

export type MapPin = {
  id: string;
  lat: number;
  lng: number;
  /** Shown in the marker's tooltip, and in the info window when clicked. */
  label?: string;
  /** Makes the info window's title a link — used by the results map. */
  href?: string;
};

export type MapViewProps = {
  pins: MapPin[];
  /**
   * Supplying this makes the first pin draggable, and a click on the map moves
   * it. Its absence is what makes a map read-only — there is no `editable`
   * flag to get out of step with whether a handler was passed.
   */
  onPinMove?: (lat: number, lng: number) => void;
  /** Where to look when there are no pins yet. Defaults to Sydney. */
  centre?: { lat: number; lng: number };
  zoom?: number;
  height?: number;
  /** Shown under the map in edit mode. */
  hint?: string;
};

const SYDNEY = { lat: -33.8688, lng: 151.2093 };

/** Close enough to read a street sign, which is what dropping a pin needs. */
const PIN_ZOOM = 17;
const AREA_ZOOM = 13;

export function MapView({
  pins,
  onPinMove,
  centre,
  zoom,
  height = 320,
  hint,
}: MapViewProps) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const markers = useRef<google.maps.Marker[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const editable = typeof onPinMove === 'function';
  const first = pins[0];

  // Kept in a ref so the drag listener, which is attached once, always calls
  // the current handler rather than the one from the render that created it.
  const moveHandler = useRef(onPinMove);
  moveHandler.current = onPinMove;

  useEffect(() => {
    let cancelled = false;

    loadGoogleMaps()
      .then((maps) => {
        if (cancelled || !holder.current) return;

        const start = first
          ? { lat: first.lat, lng: first.lng }
          : (centre ?? SYDNEY);

        map.current = new maps.Map(holder.current, {
          center: start,
          zoom: zoom ?? (first ? PIN_ZOOM : AREA_ZOOM),
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: !editable,
          // A property is looked at from above; the default road map hides the
          // roof line an agent uses to check they have the right house.
          mapTypeId: editable ? 'hybrid' : 'roadmap',
        });

        if (editable) {
          map.current.addListener('click', (e: google.maps.MapMouseEvent) => {
            const p = e.latLng;
            if (p) moveHandler.current?.(p.lat(), p.lng());
          });
        }

        setReady(true);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
    // Built once. Pins and centre are applied by the effect below, so changing
    // them pans an existing map instead of tearing it down and rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Markers, rebuilt whenever the pins change.
  useEffect(() => {
    if (!ready || !map.current || !window.google?.maps) return;
    const maps = window.google.maps;

    for (const m of markers.current) m.setMap(null);
    markers.current = [];

    for (const [i, pin] of pins.entries()) {
      const marker = new maps.Marker({
        position: { lat: pin.lat, lng: pin.lng },
        map: map.current,
        draggable: editable && i === 0,
        title: pin.label,
      });

      if (editable && i === 0) {
        marker.addListener('dragend', (e: google.maps.MapMouseEvent) => {
          const p = e.latLng;
          if (p) moveHandler.current?.(p.lat(), p.lng());
        });
      }

      if (!editable && (pin.label || pin.href)) {
        const info = new maps.InfoWindow({
          content: pin.href
            ? `<a href="${pin.href}" style="font:600 13px system-ui;color:#0b3d2e">${pin.label ?? 'View listing'}</a>`
            : `<span style="font:600 13px system-ui">${pin.label ?? ''}</span>`,
        });
        marker.addListener('click', () => info.open({ map: map.current!, anchor: marker }));
      }

      markers.current.push(marker);
    }

    if (!pins.length) return;

    if (pins.length > 1) {
      // Frame every result rather than centring on the first one, which would
      // leave most of them off screen.
      const bounds = new maps.LatLngBounds();
      for (const p of pins) bounds.extend({ lat: p.lat, lng: p.lng });
      map.current.fitBounds(bounds, 48);
    } else if (pins[0]) {
      map.current.panTo({ lat: pins[0].lat, lng: pins[0].lng });
    }
  }, [pins, ready, editable]);

  /**
   * Follow the centre when there is no pin to follow instead.
   *
   * This is what lets somebody search a suburb and be taken there to drop the
   * pin by hand: the suburb gives a place to look, not a pin, because a suburb
   * centroid is not where the house is.
   */
  useEffect(() => {
    if (!ready || !map.current || pins.length || !centre) return;
    map.current.panTo(centre);
    map.current.setZoom(AREA_ZOOM);
  }, [ready, centre?.lat, centre?.lng, pins.length]);

  if (error) {
    const unconfigured = !mapsBrowserKey();
    return (
      <div className={styles.fallback} style={{ minHeight: height }} role="note">
        <p className={styles.fallbackTitle}>
          {unconfigured ? 'Map not configured' : 'Map could not load'}
        </p>
        <p className={styles.fallbackBody}>
          {unconfigured
            ? 'Set NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY to show the map. Everything else on this page works without it.'
            : error}
        </p>
        {first ? (
          // The coordinates are the point of the map, so they are shown even
          // when the map itself cannot be.
          <p className={styles.coords}>
            {first.lat.toFixed(6)}, {first.lng.toFixed(6)}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div ref={holder} className={styles.canvas} style={{ height }} />
      {!ready ? <div className={styles.loading}>Loading map…</div> : null}
      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </div>
  );
}
