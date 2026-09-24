'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useOptimistic, useState, useTransition } from 'react';
import type { ListingCounts, ListingRow, ListingStatus } from '@repo/core/listings';
import { deleteListingAction, setListingStatusAction } from '@/lib/listing-actions';
import { useToast } from '@/components/toast';
import styles from './listing-table.module.css';

/** Dates do not survive the server/client boundary, so they arrive as ISO. */
export type Row = Omit<ListingRow, 'createdAt'> & { createdAt: string };

/**
 * CSS module keys are typed as possibly undefined, so the class is picked
 * here rather than held in a Record — the same shape toast.tsx uses.
 */
function statusClass(status: ListingStatus): string | undefined {
  switch (status) {
    case 'live':
      return styles.live;
    case 'under_offer':
    case 'sold':
      return styles.offer;
    case 'withdrawn':
      return styles.gone;
    default:
      return styles.draft;
  }
}

const STATUS_LABEL: Record<ListingStatus, string> = {
  live: 'Live',
  draft: 'Draft',
  pending: 'Pending',
  under_offer: 'Under offer',
  sold: 'Sold',
  withdrawn: 'Withdrawn',
};

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});

/**
 * What to show as the price.
 *
 * priceDisplay is the copy the agency wrote and is preferred whenever it
 * exists; the numbers are the search range and are only formatted when there
 * is no copy. The display string is never parsed — non-negotiable #6.
 */
function priceOf(row: Row): { main: string; hint?: string } {
  if (row.channel === 'rent' || row.channel === 'leased') {
    return { main: row.rentPw ? `${AUD.format(row.rentPw)} pw` : 'Contact agent' };
  }
  if (row.priceDisplay) {
    const range =
      row.priceFrom && row.priceTo
        ? `${AUD.format(row.priceFrom)} – ${AUD.format(row.priceTo)}`
        : row.priceFrom
          ? `from ${AUD.format(row.priceFrom)}`
          : undefined;
    return { main: row.priceDisplay, hint: range };
  }
  if (row.priceFrom) return { main: AUD.format(row.priceFrom) };
  return { main: 'Contact agent' };
}

function specs(row: Row): string {
  const parts = [
    row.bedrooms !== null ? `${row.bedrooms} bd` : null,
    row.bathrooms !== null ? `${row.bathrooms} ba` : null,
    row.carSpaces !== null ? `${row.carSpaces} car` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

export function ListingTable({
  rows,
  title,
  subtitle,
  newHref,
  emptyHint,
  editHrefBase,
  canDelete,
  counts,
  page,
  pageSize,
  basePath,
}: {
  rows: Row[];
  title: string;
  subtitle: string;
  newHref: string;
  emptyHint: string;
  /** `${editHrefBase}/${id}/edit` — the two surfaces mount listings differently. */
  editHrefBase: string;
  /**
   * Whether this actor may delete, decided by can() on the server.
   *
   * Passed in rather than worked out here: non-negotiable #2 puts every
   * permission decision in can(), and a component comparing roles is exactly
   * what that rule exists to prevent. The server refuses regardless — this
   * only stops the console offering a button that always fails.
   */
  canDelete: boolean;
  /**
   * Total / live / draft for the WHOLE book, counted by Postgres.
   *
   * Not derived from `rows` any more. They were, which is why this table used
   * to be handed every listing the agency had ever written: two numbers in the
   * header were holding the entire query open.
   */
  counts: ListingCounts;
  /** 1-based, from ?page= . */
  page: number;
  pageSize: number;
  /** Where the pager's links point — the two surfaces mount listings differently. */
  basePath: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  /** Which row is one click away from deletion. Null when nothing is armed. */
  const [confirming, setConfirming] = useState<string | null>(null);

  /**
   * The status badge flips before the server answers.
   *
   * Publishing is one round trip to another region, and watching an unchanged
   * row for a second reads as "the click did nothing". React reverts this on
   * its own when the transition ends, so a failed action needs no undo path —
   * the row simply goes back to what the server still says it is.
   */
  const [view, applyOptimistic] = useOptimistic(
    { rows, ...counts },
    (
      current: { rows: Row[] } & ListingCounts,
      change: { id: string; status: ListingStatus } | { id: string; remove: true },
    ) => {
      const row = current.rows.find((r) => r.id === change.id);
      if (!row) return current;

      // The counts move with the row. They come from the server now, so a
      // publish that only changed the badge would leave the header saying
      // "Live 3" above four live rows until the page came back.
      const shift = (
        state: { rows: Row[] } & ListingCounts,
        status: ListingStatus,
        by: number,
      ) => ({
        ...state,
        live: status === 'live' ? state.live + by : state.live,
        draft: status === 'draft' ? state.draft + by : state.draft,
      });

      if ('remove' in change) {
        const next = shift({ ...current, total: current.total - 1 }, row.status, -1);
        return { ...next, rows: current.rows.filter((r) => r.id !== change.id) };
      }

      const next = shift(shift(current, row.status, -1), change.status, 1);
      return {
        ...next,
        rows: current.rows.map((r) =>
          r.id === change.id ? { ...r, status: change.status } : r,
        ),
      };
    },
  );

  const optimisticRows = view.rows;
  const pages = Math.max(1, Math.ceil(view.total / pageSize));
  const pageHref = (n: number) => (n <= 1 ? basePath : `${basePath}?page=${n}`);

  function move(row: Row, next: 'live' | 'draft' | 'withdrawn') {
    startTransition(async () => {
      applyOptimistic({ id: row.id, status: next });

      const result = await setListingStatusAction(row.id, next);

      if (!result.ok) {
        toast({ variant: 'error', title: 'Status not changed', description: result.error });
        return;
      }

      toast({
        variant: 'success',
        title:
          next === 'live'
            ? 'Listing is live'
            : next === 'draft'
              ? 'Back to draft'
              : 'Listing withdrawn',
        description:
          next === 'live'
            ? `${row.address} is now on the public site.`
            : `${row.address} is no longer public.`,
      });

      // Re-read from the server so the optimistic value is replaced by the
      // real one rather than merely agreeing with it.
      router.refresh();
    });
  }

  /**
   * Delete, once the second click confirms it.
   *
   * The row disappears before the server answers, like a publish does, but the
   * refusals here are ordinary rather than exceptional — a live listing must be
   * withdrawn first, and only an admin may delete at all. Those come back as a
   * message written in packages/core, so the rule is stated in one place and
   * this only has to show it.
   */
  function remove(row: Row) {
    setConfirming(null);
    startTransition(async () => {
      applyOptimistic({ id: row.id, remove: true });

      const result = await deleteListingAction(row.id);

      if (!result.ok) {
        toast({
          variant: result.code === 'conflict' ? 'warning' : 'error',
          title: 'Listing not deleted',
          description: result.error,
        });
        // The optimistic removal unwinds on its own when the transition ends,
        // so the row comes back without an undo path of its own.
        return;
      }

      toast({
        variant: 'success',
        title: 'Listing deleted',
        description: `${row.address} is gone. The property record it sat on was kept.`,
      });

      router.refresh();
    });
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.sub}>{subtitle}</p>
        </div>
        <Link href={newHref} className={styles.add} prefetch>
          <span className={styles.glyphSm} aria-hidden>
            add_home
          </span>
          Add listing
        </Link>
      </div>

      <div className={styles.stats}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Total</div>
          <div className={styles.statVal}>{view.total}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Live</div>
          <div className={styles.statVal}>{view.live}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Drafts</div>
          <div className={styles.statVal}>{view.draft}</div>
        </div>
      </div>

      <div className={styles.card}>
        {optimisticRows.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No listings yet</p>
            <p className={styles.emptyHint}>{emptyHint}</p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Address</th>
                <th>Specs</th>
                <th>Price</th>
                <th>Agents</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {optimisticRows.map((row) => {
                const price = priceOf(row);
                return (
                  <tr key={row.id}>
                    <td>
                      <div className={styles.addr}>{row.address}</div>
                      {row.headline ? <div className={styles.headline}>{row.headline}</div> : null}
                    </td>
                    <td className={styles.specs}>{specs(row)}</td>
                    <td className={styles.price}>
                      {price.main}
                      {price.hint ? <div className={styles.priceHint}>{price.hint}</div> : null}
                    </td>
                    <td>{row.agents.join(', ') || '—'}</td>
                    <td>
                      <span className={`${styles.badge} ${statusClass(row.status)}`}>
                        {STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td>
                      <div className={styles.actions}>
                        {row.status === 'live' ? (
                          <button
                            type="button"
                            className={styles.btn}
                            disabled={isPending}
                            onClick={() => move(row, 'withdrawn')}
                          >
                            Withdraw
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={styles.btn}
                            disabled={isPending}
                            onClick={() => move(row, 'live')}
                          >
                            <span className={styles.glyphSm} aria-hidden>
                              public
                            </span>
                            Publish
                          </button>
                        )}

                        <Link
                          href={`${editHrefBase}/${row.id}/edit`}
                          className={styles.btn}
                          prefetch
                        >
                          <span className={styles.glyphSm} aria-hidden>
                            edit
                          </span>
                          Edit
                        </Link>

                        {canDelete ? (
                          confirming === row.id ? (
                            <>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnDanger}`}
                                disabled={isPending}
                                onClick={() => remove(row)}
                              >
                                Delete for good
                              </button>
                              <button
                                type="button"
                                className={styles.btn}
                                disabled={isPending}
                                onClick={() => setConfirming(null)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnQuiet}`}
                              disabled={isPending}
                              // Two clicks rather than a browser confirm(): the
                              // dialog blocks the whole tab and reads as a page
                              // error, and this row's own buttons are where the
                              // user is already looking.
                              onClick={() => setConfirming(row.id)}
                            >
                              <span className={styles.glyphSm} aria-hidden>
                                delete
                              </span>
                              Delete
                            </button>
                          )
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/*
        Only when there is somewhere to go. Plain links, so Back and Forward
        work and a page of the book can be sent to someone — the same reason
        the public search pages through the URL rather than through state.
      */}
      {pages > 1 ? (
        <nav className={styles.pager} aria-label="Pages">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className={styles.pageLink} rel="prev">
              Previous
            </Link>
          ) : (
            <span className={`${styles.pageLink} ${styles.pageLinkOff}`}>Previous</span>
          )}
          <span className={styles.pageOf}>
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={pageHref(page + 1)} className={styles.pageLink} rel="next">
              Next
            </Link>
          ) : (
            <span className={`${styles.pageLink} ${styles.pageLinkOff}`}>Next</span>
          )}
        </nav>
      ) : null}
    </div>
  );
}
