import Link from 'next/link';
import type { ResultsEvent } from '@repo/ai/chat-events';
import { ListingCard } from '../../components/listing-card';
import styles from './chat.module.css';

/**
 * What the guide found, beside what it said.
 *
 * This panel never renders a word the model wrote. It renders the rows the
 * server put in the `results` frame, through the same ListingCard the search
 * page uses — so every price on screen came from SQL, whatever the answer next
 * to it claims. That is non-negotiable #4 made visible rather than promised.
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
}: {
  results: ResultsEvent | null;
  hidden: boolean;
}) {
  const chips = results ? filterChips(results) : [];
  const listings = results?.listings ?? [];

  return (
    <section
      className={`${styles.panel} ${hidden ? styles.hidden : ''}`}
      aria-label="Search results"
    >
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>Results</h2>
        {results ? (
          <span className={styles.panelCount}>
            {results.capped ? `${results.matched}+ matches` : `${results.matched} matches`}
            {results.matched > listings.length && listings.length > 0
              ? ` · showing ${listings.length}`
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
            Tell the guide what you are after and matching homes will appear here.
          </p>
        ) : listings.length === 0 ? (
          <p className={styles.panelEmpty}>
            {results.matched === 0
              ? 'Nothing live matches that yet.'
              : 'Too many to be useful — the guide needs a little more to go on.'}
          </p>
        ) : (
          listings.map((listing) => (
            <ListingCard
              key={listing.id}
              listing={listing}
              searchedSuburb={results.query.suburb}
            />
          ))
        )}
      </div>

      {results && listings.length > 0 ? (
        <div className={styles.panelFoot}>
          {/*
            The link is built by the server from the query it ran, never by the
            model. prefetch={false} because this is a dynamic search page and
            prefetching it would run the search twice.
          */}
          <Link href={results.deepLink} className={styles.openAll} prefetch={false}>
            Open these in search →
          </Link>
        </div>
      ) : null}
    </section>
  );
}
