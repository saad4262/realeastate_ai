'use client';

import { useEffect, useRef, useState } from 'react';
import { groupPins, type PinGroup } from './group-pins';
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
/**
 * Framing pins never zooms in past this. Pins a few metres apart (or all on one
 * building) give fitBounds a box of nothing, and it would dive to the map's
 * deepest zoom, where the street is a grey blur.
 */
const MAX_FIT_ZOOM = 18;

/**
 * What a marker's popup shows: a link (or a line) per pin.
 *
 * Built from DOM nodes with textContent, never an HTML string — a label is an
 * address or a price an agent typed, and `<img onerror>` in a street name
 * must stay text.
 */
function popupContent(group: PinGroup): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText = 'font:13px/1.4 system-ui,sans-serif;max-width:260px';
  if (group.pins.length > 1) {
    const head = document.createElement('div');
    head.textContent = `${group.pins.length} properties at this spot`;
    head.style.cssText = 'font-weight:700;margin:0 0 6px';
    box.appendChild(head);
  }
  const list = document.createElement(group.pins.length > 1 ? 'ul' : 'div');
  if (group.pins.length > 1) list.style.cssText = 'list-style:none;margin:0;padding:0;display:grid;gap:4px';
  for (const pin of group.pins) {
    const item = document.createElement(group.pins.length > 1 ? 'li' : 'div');
    const text = pin.label ?? (pin.href ? 'View listing' : '');
    if (pin.href) {
      const a = document.createElement('a');
      a.href = pin.href;
      a.textContent = text;
      a.style.cssText = 'font-weight:600;color:#0b3d2e';
      item.appendChild(a);
    } else {
      item.textContent = text;
      item.style.fontWeight = '600';
    }
    if (group.pins.length > 1) item.style.cssText += ';padding:4px 0;border-top:1px solid #e5e7eb';
    list.appendChild(item);
  }
  box.appendChild(list);
  return box;
}

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
  /** The one popup the read-only map shows; opening it for another marker moves it there. */
  const info = useRef<google.maps.InfoWindow | null>(null);
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
    info.current?.close();

    if (editable) {
      // Placing a pin: one marker, the first pin, and it is the one you drag.
      const pin = pins[0];
      if (pin) {
        const marker = new maps.Marker({ position: { lat: pin.lat, lng: pin.lng }, map: map.current, draggable: true, title: pin.label });
        marker.addListener('dragend', (e: google.maps.MapMouseEvent) => {
          const p = e.latLng;
          if (p) moveHandler.current?.(p.lat(), p.lng());
        });
        markers.current.push(marker);
      }
    } else {
      // Reading results: pins on the same spot (units of one building) share ONE marker with a
      // count, and its popup lists each of them — stacked markers left all but the top one
      // unclickable. One popup for the whole map, so opening one closes the last.
      const popup = (info.current ??= new maps.InfoWindow());
      for (const group of groupPins(pins)) {
        const many = group.pins.length > 1;
        const marker = new maps.Marker({
          position: { lat: group.lat, lng: group.lng },
          map: map.current,
          title: many ? `${group.pins.length} properties at this spot` : group.pins[0]!.label,
          ...(many ? { label: { text: String(group.pins.length), color: '#ffffff', fontWeight: '700', fontSize: '12px' } } : {}),
          zIndex: many ? 2 : 1,
        });
        if (many || group.pins[0]!.label || group.pins[0]!.href) {
          marker.addListener('click', () => {
            popup.setContent(popupContent(group));
            popup.open({ map: map.current!, anchor: marker });
          });
        }
        markers.current.push(marker);
      }
    }

    if (!pins.length) return;

    const spots = groupPins(pins);
    if (spots.length > 1) {
      // Frame every result rather than centring on the first one, which would
      // leave most of them off screen — but never dive past street level.
      const bounds = new maps.LatLngBounds();
      for (const p of pins) bounds.extend({ lat: p.lat, lng: p.lng });
      map.current.fitBounds(bounds, 48);
      maps.event.addListenerOnce(map.current, 'idle', () => {
        const z = map.current?.getZoom();
        if (z !== undefined && z > MAX_FIT_ZOOM) map.current?.setZoom(MAX_FIT_ZOOM);
      });
    } else if (spots[0]) {
      // One spot — one pin, or every unit of one building: centre on it at street level.
      map.current.panTo({ lat: spots[0].lat, lng: spots[0].lng });
      // Not while placing a pin: every drag lands here, and the agent's own zoom must stay.
      if (!editable && zoom === undefined) map.current.setZoom(PIN_ZOOM);
    }
  }, [pins, ready, editable, zoom]);

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
