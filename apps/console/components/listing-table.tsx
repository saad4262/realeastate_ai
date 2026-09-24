'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useOptimistic, useState, useTransition } from 'react';
import type { ListingRow, ListingStatus } from '@repo/core/listings';
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
  const [optimisticRows, applyOptimistic] = useOptimistic(
    rows,
    (current: Row[], change: { id: string; status: ListingStatus } | { id: string; remove: true }) =>
      'remove' in change
        ? current.filter((r) => r.id !== change.id)
        : current.map((r) => (r.id === change.id ? { ...r, status: change.status } : r)),
  );

  const live = optimisticRows.filter((r) => r.status === 'live').length;
  const drafts = optimisticRows.filter((r) => r.status === 'draft').length;

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
          <div className={styles.statVal}>{optimisticRows.length}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Live</div>
          <div className={styles.statVal}>{live}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Drafts</div>
          <div className={styles.statVal}>{drafts}</div>
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
    </div>
  );
}
