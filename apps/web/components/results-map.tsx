'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import type { MapPin } from '@repo/ui/maps';
import styles from './results-map.module.css';

/**
 * The map arrives only when someone asks for it.
 *
 * MapView was a static import, so its code shipped with this component whether
 * or not the map was ever opened — and it is collapsed by default, because a
 * map costs a script load and a billed map view and most searches are read as
 * a list. Rendering it conditionally was never code splitting; the module was
 * in the bundle either way.
 *
 * ssr: false because a map cannot render on the server at all: it needs
 * `window` and a Google script that only exists in a browser.
 */
const MapView = dynamic(() => import('@repo/ui/maps').then((m) => m.MapView), {
  ssr: false,
});


/**
 * Every result that has a pin, on one map.
 *
 * Collapsed by default on search: the map costs a script load and a billed map
 * view, and most searches are read as a list. Opening it is a deliberate act.
 * Chat passes `defaultOpen` so pins sit beside the conversation.
 *
 * Unpinned results are counted rather than hidden silently — a buyer comparing
 * "12 results" with nine markers should be told why, not left to guess.
 */
export function ResultsMap({
  pins,
  unpinned,
  defaultOpen = false,
  height = 420,
}: {
  pins: MapPin[];
  unpinned: number;
  defaultOpen?: boolean;
  height?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!pins.length) return null;

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.toggle} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide map' : `Show ${pins.length} on a map`}
      </button>

      {open ? (
        <>
          <MapView pins={pins} height={height} />
          {unpinned > 0 ? (
            <p className={styles.note}>
              {unpinned} {unpinned === 1 ? 'result is' : 'results are'} not on the map — those
              listings have no pin yet.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
