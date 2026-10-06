/**
 * The agency's Google rating and reviews (ADR 0028 step 1), as Google's
 * Places terms require them to be shown: Google's attribution, each review's
 * author (name, photo, link to their profile), a link to every review on
 * Google Maps, and a notice that Google chose and ordered them. Both apps
 * render reviews ONLY through this component — a test holds that.
 *
 * Plain props, no data access: the server fetched them from Google for this
 * view and keeps nothing.
 */

export type GoogleReviewsData = {
  agencyName: string;
  place: {
    name: string;
    rating: number | null;
    ratingCount: number;
    mapsUri: string | null;
    reviews: {
      rating: number;
      text: string;
      when: string;
      author: { name: string; uri: string | null; photoUri: string | null };
      mapsUri: string | null;
    }[];
  };
};

const muted = 'var(--text-secondary, #5f6368)';

function Stars({ value }: { value: number }) {
  const full = Math.round(value);
  return (
    <span aria-label={`${value} out of 5 stars`} style={{ color: '#f4b400', letterSpacing: '1px' }}>
      {'★'.repeat(full)}
      <span style={{ color: '#dadce0' }}>{'★'.repeat(Math.max(0, 5 - full))}</span>
    </span>
  );
}

/** Google's attribution. Text form ("Google Maps") — the terms allow it where the logo does not fit. */
export function GoogleAttribution() {
  return (
    <span style={{ fontSize: '0.75rem', color: muted }} data-google-attribution>
      Ratings and reviews from <strong style={{ fontFamily: 'Roboto, Arial, sans-serif', fontWeight: 500 }}>Google Maps</strong>
    </span>
  );
}

export function GoogleReviews({ data, heading }: { data: GoogleReviewsData; heading?: string }) {
  const { place } = data;
  return (
    <section aria-label={heading ?? `Reviews of ${data.agencyName}`} style={{ display: 'grid', gap: '0.75rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0.5rem', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>{heading ?? `Reviews of ${data.agencyName}`}</h2>
        <GoogleAttribution />
      </div>
      {place.rating !== null ? (
        <p style={{ margin: 0, display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: '1.5rem' }}>{place.rating.toFixed(1)}</strong>
          <Stars value={place.rating} />
          <span style={{ color: muted }}>
            {place.ratingCount.toLocaleString('en-AU')} {place.ratingCount === 1 ? 'review' : 'reviews'} on Google
          </span>
          {place.mapsUri ? (
            <a href={place.mapsUri} target="_blank" rel="noopener noreferrer">
              See all on Google Maps
            </a>
          ) : null}
        </p>
      ) : null}
      {place.reviews.length ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.75rem' }}>
          {place.reviews.map((r, i) => (
            <li key={i} style={{ borderTop: '1px solid var(--border-default, #e0e0e0)', paddingTop: '0.75rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {r.author.photoUri ? (
                  // eslint-disable-next-line @next/next/no-img-element -- Google's own avatar URL, shown as given
                  <img src={r.author.photoUri} alt="" width={28} height={28} referrerPolicy="no-referrer" style={{ borderRadius: '50%' }} />
                ) : null}
                {r.author.uri ? (
                  <a href={r.author.uri} target="_blank" rel="noopener noreferrer" data-review-author>
                    {r.author.name}
                  </a>
                ) : (
                  <span data-review-author>{r.author.name}</span>
                )}
                <Stars value={r.rating} />
                <span style={{ color: muted, fontSize: '0.8125rem' }}>{r.when}</span>
              </div>
              {r.text ? <p style={{ margin: '0.375rem 0 0', whiteSpace: 'pre-line' }}>{r.text}</p> : null}
              {r.mapsUri ? (
                <a href={r.mapsUri} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.8125rem' }} data-review-link>
                  View on Google Maps
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p style={{ margin: 0, fontSize: '0.75rem', color: muted }}>
        These are the reviews Google makes public for {place.name || data.agencyName}, chosen and ordered by Google and shown
        unfiltered. They are reviews of the agency, not of an individual agent.
      </p>
    </section>
  );
}
