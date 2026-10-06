'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { GoogleAttribution } from '@repo/ui/google-reviews';
import type { PlaceHit } from '@repo/core/reviews';
import { clearPlaceAction, pickPlaceAction, searchPlacesAction } from '@/lib/review-actions';

const btn: React.CSSProperties = { padding: '0.45rem 0.9rem', borderRadius: '0.5rem', border: 0, background: 'var(--sapphire)', color: '#fff', fontWeight: 600, cursor: 'pointer' };
const ghost: React.CSSProperties = { padding: '0.45rem 0.9rem', borderRadius: '0.5rem', border: '1px solid var(--border-default)', background: 'transparent', cursor: 'pointer' };

/** Find the agency's Google listing by name and suburb; pick one. Owner/admin only (the server checks). */
export function PlacePicker({ linked }: { linked: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PlaceHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const r = await searchPlacesAction(q);
            if (r.ok) setHits(r.hits);
            else setError(r.error);
          });
        }}
        style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Your agency’s name and suburb, as on Google"
          aria-label="Search Google for your agency"
          style={{ flex: '1 1 18rem', padding: '0.45rem 0.6rem', borderRadius: '0.5rem', border: '1px solid var(--border-default)' }}
        />
        <button type="submit" style={btn} disabled={pending}>
          {pending ? 'Searching…' : linked ? 'Find a different listing' : 'Find our Google listing'}
        </button>
        {linked ? (
          <button
            type="button"
            style={ghost}
            disabled={pending}
            onClick={() =>
              confirm('Stop showing Google reviews? Public pages will show nothing until you pick a listing again.') &&
              start(async () => {
                const r = await clearPlaceAction();
                if (!r.ok) setError(r.error);
                router.refresh();
              })
            }
          >
            Remove
          </button>
        ) : null}
      </form>
      {error ? <p role="alert" style={{ color: 'var(--rose)', margin: 0 }}>{error}</p> : null}
      {hits ? (
        hits.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.5rem' }}>
            {hits.map((h) => (
              <li key={h.placeId} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', justifyContent: 'space-between', border: '1px solid var(--border-default)', borderRadius: '0.5rem', padding: '0.5rem 0.75rem' }}>
                <span>
                  <strong>{h.name}</strong>
                  <br />
                  <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                    {h.address}
                    {h.rating !== null ? ` · ${h.rating.toFixed(1)}★ (${h.ratingCount.toLocaleString('en-AU')})` : ' · no rating yet'}
                  </span>
                </span>
                <button
                  type="button"
                  style={ghost}
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await pickPlaceAction(h.placeId);
                      if (!r.ok) return setError(r.error);
                      setHits(null);
                      router.refresh();
                    })
                  }
                >
                  This is us
                </button>
              </li>
            ))}
            <li>
              <GoogleAttribution />
            </li>
          </ul>
        ) : (
          <p style={{ margin: 0 }}>Google found nothing for that. Try the name exactly as it appears on Google Maps, with the suburb.</p>
        )
      ) : null}
    </div>
  );
}
