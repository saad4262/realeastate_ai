'use client';

import { memo } from 'react';
import Link from 'next/link';
import type { ResultsEvent, SalesEvent } from '@repo/ai/chat-events';
import { ListingCard } from '../../components/listing-card';
import { SoldListingCard } from '../../components/sold-card';
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

/**
 * What has sold, as its own labelled block.
 *
 * Deliberately NOT a ListingCard. A sale cannot be enquired about, inspected or
 * bought, and rendering it through the same card would invite the exact
 * confusion the prompt spends three rules preventing — starting with a visitor
 * clicking "Enquire" on a house somebody else already owns.
 *
 * Every figure here is a string the server formatted from SQL. Nothing on this
 * panel is ever a number the model produced (#4).
 */
function SoldList({ sales }: { sales: SalesEvent }) {
  if (sales.sales.length === 0) return null;

  /**
   * Sales go on a map for the same reason live results do: "within 30 km" is a
   * claim about geography, and a list of addresses does not show it. Built from
   * the same pin shape, so the one ResultsMap draws both.
   */
  const pins = sales.sales
    .filter((s) => s.latitude !== null && s.longitude !== null)
    .map((s) => ({
      id: s.listingId,
      lat: s.latitude as number,
      lng: s.longitude as number,
      label: `${s.price} · ${s.address}`,
      // A pin only links where the page exists, exactly as the card does.
      href: s.historyPath ?? undefined,
    }));
  const unpinned = sales.sales.length - pins.length;

  return (
    <div className={styles.soldBlock}>
      <div className={styles.soldHead}>
        <h3 className={styles.soldTitle}>Recently sold</h3>
        <span className={styles.soldScope}>
          {sales.searched} · last {sales.months} months
        </span>
      </div>

      {pins.length > 0 ? (
        <ResultsMap pins={pins} unpinned={unpinned} defaultOpen height={200} />
      ) : null}

      {sales.sales.map((sale) => (
        <div key={sale.listingId} className={styles.listingWrap}>
          <SoldListingCard sale={sale} variant="compact" />
        </div>
      ))}

      {/*
        The same affordance a live search gets. The guide is forbidden from
        writing links out, so this is the only way a visitor reaches the full
        list — and its absence is what made the guide read out addresses
        instead.
      */}
      <Link href={sales.searchPath} className={styles.soldAll} prefetch={false}>
        View all {sales.total} sold
        <span aria-hidden>↗</span>
      </Link>
    </div>
  );
}

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

/**
 * Memoised, because it owns a Google map.
 *
 * Its props change when a search returns — which is rarely — but its
 * parent re-renders on every streamed token. Without this the map is
 * reconciled on each one, which is what made the pins visibly flicker
 * while an answer was being written.
 */
function ResultsPanelImpl({
  results,
  hidden,
  embedded,
  sales,
}: {
  results: ResultsEvent | null;
  /** Legacy mobile hide — prefer the sidebar's own mobile class when embedded. */
  hidden?: boolean;
  /** Nested under the search brief in the redesigned sidebar. */
  embedded?: boolean;
  /**
   * Completed sales, when the guide looked them up.
   *
   * Rendered below the matches and labelled apart from them, because a sale is
   * not something the visitor can buy. It was the absence of this that made the
   * guide point at an empty panel: `recent_sales` had nowhere to put what it
   * found, so the answer described results nobody could see.
   */
  sales?: SalesEvent | null;
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
        {/*
          Sales first when there are no live matches, because then they are the
          whole answer — and after the matches when both exist, because a home
          somebody can actually buy is the more useful of the two.
        */}
        {sales && listings.length === 0 ? <SoldList sales={sales} /> : null}

        {!results && !sales ? (
          <p className={styles.panelEmpty}>
            Matching homes will land here once we run a search.
          </p>
        ) : !results ? null : listings.length === 0 ? (
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
            {/* And the sales under them, when the guide looked up both. */}
            {sales ? <SoldList sales={sales} /> : null}
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

export const ResultsPanel = memo(ResultsPanelImpl);
