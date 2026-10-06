'use client';

import { useSyncExternalStore } from 'react';

/**
 * Contacts picked in the directory for the assistant (ADR 0025 Phase D).
 * A tiny in-browser store shared by the row checkboxes, the "N selected" bar
 * and the panel. Only ids leave the browser — the server turns them into S1,
 * S2… after checking this person may see each one; names here are for the
 * chip only.
 */

export const MAX_PICKS = 20;

type Pick = { id: string; name: string };
let picks: Pick[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function togglePick(p: Pick): void {
  picks = picks.some((x) => x.id === p.id) ? picks.filter((x) => x.id !== p.id) : picks.length >= MAX_PICKS ? picks : [...picks, p];
  emit();
}

export function clearPicks(): void {
  picks = [];
  emit();
}

export function usePicks(): Pick[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => picks,
    () => picks,
  );
}

/** Open the assistant panel (it listens for this). */
export function openAssistant(): void {
  window.dispatchEvent(new CustomEvent('assistant:open'));
}
