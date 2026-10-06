'use client';

import { MAX_PICKS, clearPicks, openAssistant, togglePick, usePicks } from '../assistant/picks';
import styles from './pick-contact.module.css';

/** The row checkbox: pick this contact for the assistant. */
export function PickContact({ id, name }: { id: string; name: string }) {
  const picks = usePicks();
  const on = picks.some((p) => p.id === id);
  return (
    <input
      type="checkbox"
      className={styles.box}
      checked={on}
      disabled={!on && picks.length >= MAX_PICKS}
      onChange={() => togglePick({ id, name })}
      aria-label={`Pick ${name} for the assistant`}
    />
  );
}

/** "N selected — Ask the assistant", while anyone is picked. */
export function PickedBar() {
  const picks = usePicks();
  if (!picks.length) return null;
  return (
    <div className={styles.bar} role="status">
      <span>
        {picks.length} selected{picks.length >= MAX_PICKS ? ` (the most at once)` : ''}
      </span>
      <button type="button" className={styles.ask} onClick={openAssistant}>
        Ask the assistant about them
      </button>
      <button type="button" className={styles.clear} onClick={clearPicks}>
        Clear
      </button>
    </div>
  );
}
