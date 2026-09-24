'use client';

import { useState } from 'react';
import { MapView, type MapPin } from '@repo/ui/maps';
import styles from './results-map.module.css';

/**
 * Every result that has a pin, on one map.
 *
 * Collapsed by default: the map costs a script load and a billed map view, and
 * most searches are read as a list. Opening it is a deliberate act.
 *
 * Unpinned results are counted rather than hidden silently — a buyer comparing
 * "12 results" with nine markers should be told why, not left to guess.
 */
export function ResultsMap({ pins, unpinned }: { pins: MapPin[]; unpinned: number }) {
  const [open, setOpen] = useState(false);

  if (!pins.length) return null;

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.toggle} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide map' : `Show ${pins.length} on a map`}
      </button>

      {open ? (
        <>
          <MapView pins={pins} height={420} />
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
