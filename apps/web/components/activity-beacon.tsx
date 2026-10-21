'use client';

import { useEffect } from 'react';

/**
 * Tells the server what this page was — a search, or a listing opened — once
 * it has rendered (ADR 0051). Off the page's own path: the page never waits
 * for it, and a failure is ignored. `keepalive` lets it finish if the visitor
 * clicks away at once. Renders nothing.
 */
export function ActivityBeacon(
  props: { kind: 'search'; query: Record<string, unknown> } | { kind: 'listing_view'; listingId: string },
) {
  const key = JSON.stringify(props);
  useEffect(() => {
    void fetch('/api/activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: key,
      keepalive: true,
      cache: 'no-store',
    }).catch(() => {
      /* counting a visit is never worth an error */
    });
  }, [key]);
  return null;
}
