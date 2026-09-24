'use client';

import Link from 'next/link';
import type { ResultsEvent } from '@repo/ai/chat-events';
import { ListingCard } from '../../components/listing-card';
import { ResultsMap } from '../../components/results-map';
import styles from './chat.module.css';

/**
 * What the guide found, beside what it said.
 *
 * This panel never renders a word the model wrote. It renders the rows the
 * server put in the `results` frame, through the same ListingCard the search
 * page uses — so every price on screen came from SQL, whatever the answer next
 * to it claims. That is non-negotiable #4 made visible rather than promised.
 *
 * Pins come from the same rows (`latitude` / `longitude`). The model never
 * sees coordinates; the map does not need it to.
 */

/** The filters, from the query the SERVER ran — not from what the model asked for. */
function filterChips(results: ResultsEvent): string[] {
  const q = results.query;
  const rental = q.channel === 'rent' || q.channel === 'leased';
  const money = (n: number) =>
    rental
      ? `$${n.toLocaleString('en-AU')} pw`
      : `$${n.toLocaleString('en-AU')}`;

  const chips: string[] = [];
  if (q.channel) chips.push(q.channel === 'sale' ? 'For sale' : 'For rent');
  if (q.suburb) chips.push([q.suburb, q.state].filter(Boolean).join(' '));
  if (q.near) chips.push(`within ${q.near.radiusKm} km`);
  if (q.bedrooms !== undefined) chips.push(`${q.bedrooms}+ bed`);
  if (q.bathrooms !== undefined) chips.push(`${q.bathrooms}+ bath`);
  if (q.carSpaces !== undefined) chips.push(`${q.carSpaces}+ car`);
  if (q.propertyType) chips.push(q.propertyType);
  if (q.priceFrom !== undefined) chips.push(`from ${money(q.priceFrom)}`);
  if (q.priceTo !== undefined) chips.push(`under ${money(q.priceTo)}`);
  if (q.text) chips.push(`"${q.text}"`);
  return chips;
}

export function ResultsPanel({
  results,
  hidden,
  embedded,
}: {
  results: ResultsEvent | null;
  /** Legacy mobile hide — prefer the sidebar's own mobile class when embedded. */
  hidden?: boolean;
  /** Nested under the search brief in the redesigned sidebar. */
  embedded?: boolean;
}) {
  const chips = results ? filterChips(results) : [];
  const listings = results?.listings ?? [];
  const pins = listings
    .filter((r) => r.latitude !== null && r.longitude !== null)
    .map((r) => ({
      id: r.id,
      lat: r.latitude as number,
      lng: r.longitude as number,
      label: r.address,
      href: `/listing/${r.id}`,
    }));
  // Counted from the pins actually built: a row with a latitude but no
  // longitude is just as unplaceable, and testing latitude alone missed it.
  const unpinned = listings.length - pins.length;

  return (
    <section
      className={`${embedded ? styles.resultsEmbed : styles.panel} ${hidden ? styles.hidden : ''}`}
      aria-label="Search results"
    >
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>Matches</h2>
        {results ? (
          <span className={styles.panelCount}>
            {results.capped ? `${results.matched}+` : results.matched}
            {results.matched > listings.length && listings.length > 0
              ? ` · show ${listings.length}`
              : ''}
          </span>
        ) : null}
      </div>

      {chips.length ? (
        <div className={styles.filters}>
          {chips.map((chip) => (
            <span key={chip} className={styles.chip}>
              {chip}
            </span>
          ))}
        </div>
      ) : null}

      <div className={styles.panelBody}>
        {!results ? (
          <p className={styles.panelEmpty}>
            Matching homes will land here once we run a search.
          </p>
        ) : listings.length === 0 ? (
          <p className={styles.panelEmpty}>
            {results.matched === 0
              ? 'Nothing live matches that yet.'
              : 'Too many to be useful — the guide needs a little more to go on.'}
          </p>
        ) : (
          <>
            <ResultsMap pins={pins} unpinned={unpinned} defaultOpen height={220} />
            {listings.map((listing) => (
              <div key={listing.id} className={styles.listingWrap}>
                <ListingCard
                  listing={listing}
                  searchedSuburb={results.query.suburb}
                  variant="compact"
                />
              </div>
            ))}
          </>
        )}
      </div>

      {/*
        Shown whenever a search ran, not only when it filled the panel.
        `matched > 0` with an empty list is the too-broad case: the matches are
        real and this link is the only way to reach them. A search that matched
        nothing still gets none — /search would render the same nothing.
      */}
      {results && results.matched > 0 ? (
        <div className={styles.panelFoot}>
          {/*
            The link is built by the server from the query it ran, never by the
            model. prefetch={false} because this is a dynamic search page and
            prefetching it would run the search once here and again in the tab
            it opens.
          */}
          <Link
            href={results.deepLink}
            className={styles.openAll}
            target="_blank"
            rel="noopener"
            prefetch={false}
            aria-label={`Open ${
              results.capped ? `${results.matched}+` : results.matched
            } matching properties in search — opens in a new tab`}
          >
            {listings.length > 0 ? 'Open these in search' : 'Browse all matches'}
            <span aria-hidden> ↗</span>
          </Link>
        </div>
      ) : null}
    </section>
  );
}
