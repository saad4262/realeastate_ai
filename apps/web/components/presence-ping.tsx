'use client';

import { useEffect } from 'react';

/**
 * "I am still here" for a signed-in visitor (ADR 0052): once now, then once a
 * minute while the tab is visible. The server writes `last_seen_at` at most
 * once a minute; the admin console counts someone online for 5 minutes after.
 * Rendered only when the page believes the visitor is signed in, so anonymous
 * visitors send nothing. Renders nothing.
 */
export function PresencePing() {
  useEffect(() => {
    const ping = () => {
      if (document.visibilityState !== 'visible') return;
      void fetch('/api/activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"kind":"ping"}',
        keepalive: true,
        cache: 'no-store',
      }).catch(() => {
        /* presence is never worth an error */
      });
    };
    ping();
    const timer = setInterval(ping, 60_000);
    document.addEventListener('visibilitychange', ping);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', ping);
    };
  }, []);
  return null;
}
