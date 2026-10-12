'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { liveStampAction } from '@/lib/live-actions';

/** Every few seconds while the tab is visible — one small query, no data. */
const EVERY_MS = 5_000;

/**
 * Keeps an open console current (ADR 0035, instant delivery): when an email
 * arrives (the webhook stores it), a colleague writes, or the bell rings, the
 * page and its badges refresh by themselves. Asks the server for a stamp and
 * refreshes only when it changes — never on the first answer. Renders nothing.
 */
export function LiveRefresh() {
  const router = useRouter();
  const last = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let busy = false;
    const tick = () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      void liveStampAction()
        .then(({ stamp }) => {
          if (stopped || !stamp) return;
          if (last.current !== null && last.current !== stamp) router.refresh();
          last.current = stamp;
        })
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    };
    tick();
    const timer = setInterval(tick, EVERY_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [router]);

  return null;
}
