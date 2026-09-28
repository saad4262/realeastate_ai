'use client';

import Link from 'next/link';
import styles from './chat.module.css';

/**
 * A scheduled run, shown above the conversation.
 *
 * ## Why this is a card and not a chat turn
 *
 * The obvious move is to push the run into `turns[0]` as an assistant
 * message. It is also wrong: the transcript is what gets replayed back to
 * the model on the next request, and a fabricated assistant turn would be
 * the model reading its own words that it never said. More to the point,
 * `chatRequestSchema` deliberately gives the client no way to send a tool
 * result — a tool result is the only source of a price (#4) — and a seeded
 * turn carrying listings would be exactly that shape arriving from the
 * browser.
 *
 * So it is server-rendered data sitting beside the conversation, read-only,
 * and the conversation itself starts empty. "Continue this search" prefills
 * the composer and runs a normal live turn, which needs no server change at
 * all because it is just a message.
 *
 * ## Why the props are primitives
 *
 * Everything crossing from the Server Component arrives as JSON. A `Date`
 * would land as a string while the type still said `Date` — the class of
 * bug ARCHITECTURE § 6 names — so the string is the honest type.
 */
export type DeliveredRunProps = {
  ranAtIso: string;
  scheduleName: string;
  description: string;
  matched: number;
  newCount: number;
  summary: string | null;
  summarySource: 'model' | 'template' | 'none';
  searchPath: string;
  listings: { id: string; price: string; address: string }[];
  onContinue: () => void;
};

export function DeliveredRun({
  ranAtIso,
  scheduleName,
  description,
  matched,
  newCount,
  summary,
  summarySource,
  searchPath,
  listings,
  onContinue,
}: DeliveredRunProps) {
  const ranAt = new Date(ranAtIso);

  return (
    <aside className={styles.delivery}>
      <div className={styles.deliveryHead}>
        <p className={styles.deliveryTitle}>
          {scheduleName} — {newCount} new {newCount === 1 ? 'listing' : 'listings'}
        </p>
        <span className={styles.deliveryWhen}>
          Delivered{' '}
          <time dateTime={ranAtIso} suppressHydrationWarning>
            {ranAt.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}
          </time>
        </span>
      </div>

      <p className={styles.deliveryDesc}>{description}</p>

      {summary ? <p className={styles.deliverySummary}>{summary}</p> : null}
      {summarySource === 'model' ? (
        <p className={styles.deliveryNote}>Written by the property guide</p>
      ) : null}

      {listings.length > 0 ? (
        <ul className={styles.deliveryList}>
          {listings.slice(0, 4).map((listing) => (
            <li key={listing.id}>
              <Link href={`/listing/${listing.id}`}>
                <span className={styles.deliveryPrice}>{listing.price}</span>
                <span> — {listing.address}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <div className={styles.deliveryActions}>
        <Link href={searchPath} className={styles.schedPrimary} target="_blank" rel="noopener">
          View all {matched} results
        </Link>
        <button type="button" onClick={onContinue} className={styles.schedGhost}>
          Ask about these
        </button>
        <Link href="/alerts" className={styles.schedOff}>
          Turn off
        </Link>
      </div>

      {/*
        Said once, plainly. The conversation below this card is not stored —
        the same as every other conversation on this page — and somebody
        arriving from an email has more reason than usual to assume it is.
      */}
      <p className={styles.deliveryFoot}>This alert is saved. Anything you ask below is not.</p>
    </aside>
  );
}
