'use client';

import { useEffect, useRef, useState } from 'react';
import { GoogleReviews, type GoogleReviewsData } from '@repo/ui/google-reviews';

/**
 * The agency's Google rating and reviews on a live listing (ADR 0028). Asked
 * for from the browser when the section scrolls near the screen, so the
 * cached page never holds Google's content and an unread page costs no
 * Google call. Renders NOTHING — no box, no zero stars — until there is
 * something to show.
 */
export function ListingReviews({ listingId }: { listingId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<GoogleReviewsData | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let done = false;
    const load = () => {
      if (done) return;
      done = true;
      fetch(`/api/reviews/${encodeURIComponent(listingId)}`, { cache: 'no-store' })
        .then((r) => (r.status === 200 ? (r.json() as Promise<GoogleReviewsData>) : null))
        .then((d) => d && setData(d))
        .catch(() => undefined);
    };
    if (typeof IntersectionObserver === 'undefined') return load();
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && (load(), io.disconnect()), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [listingId]);
  return (
    <div ref={ref}>
      {data ? (
        <div style={{ border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '1rem', padding: '1.25rem', background: 'var(--surface-card, #fff)' }}>
          <GoogleReviews data={data} />
        </div>
      ) : null}
    </div>
  );
}
