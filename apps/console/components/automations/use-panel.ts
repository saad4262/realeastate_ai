'use client';

import { useEffect, type RefObject } from 'react';

/** A top-bar panel closes on a click outside it, and on Escape. */
export function usePanelDismiss(open: boolean, close: () => void, wrap: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, wrap]);
}
