import Link from 'next/link';
import type { LeadAssignee, LeadCounts, LeadKind, LeadRow } from '@repo/core/leads';
import { LeadAssignControl, LeadStatusControl } from './lead-triage';
import styles from './lead-table.module.css';

/**
 * The agency inbox.
 *
 * A server component; the two cells that mutate — status and assignee — are
 * small client islands in ./lead-triage, each optimistic on its own. Whether
 * either is a control or plain text for this actor is decided by can() on the
 * server and arrives as `mayUpdate` on the row and a non-empty `assignees`.
 *
 * ## One screen, not two
 *
 * Offers and enquiries share a table because they share a row: `lead` carries
 * one set of triage columns and every lead is anchored to a property, so an
 * offer with no listing and an enquiry with one both have an address to show.
 * See docs/adr/0012 for why a separate `private_offer` table was refused.
 *
 * What they do NOT share is how easily they are missed. Offers are rare and
 * high-value; enquiries are frequent and routine. In one date-sorted list an
 * offer would be buried by a busy week, and email is currently the only other
 * way an agency hears about one. So the tabs are not a convenience — they are
 * the thing that stops the feature failing quietly.
 */
export type Row = Omit<LeadRow, 'createdAt'> & { createdAt: string };

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});

const WHEN = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const KIND_LABEL: Record<LeadKind, string> = {
  enquiry: 'Enquiry',
  inspection: 'Inspection',
  appraisal: 'Appraisal',
  offer: 'Offer',
};

type Tab = { href: string; label: string; count?: number; on: boolean };

export function LeadTable({
  rows,
  counts,
  kind,
  maySeeOffers,
  webUrl,
  assignees,
  basePath = '/leads',
  title = 'Leads',
  subtitle,
}: {
  rows: Row[];
  /** Where the tabs point — `/leads` on the agency console, `/my-leads` on the desk. */
  basePath?: string;
  title?: string;
  /** Overrides the agency wording; the agent desk describes a narrower inbox. */
  subtitle?: string;
  /** Who a lead may be given to. Empty unless this actor may assign (can()). */
  assignees: LeadAssignee[];
  counts: LeadCounts;
  /** The consumer site's origin — the console is on a different host. */
  webUrl: string;
  /** The active tab, from the URL. Undefined means everything. */
  kind?: LeadKind;
  /** Decided by can() on the server. Never recomputed from a role here (#2). */
  maySeeOffers: boolean;
}) {
  const tabs: Tab[] = [
    { href: basePath, label: 'All', count: counts.total, on: kind === undefined },
    // Only drawn when the actor may read one. An "Offers (0)" tab shown to an
    // assistant would say three offers arrived and you may not see them, which
    // is most of what the restriction exists to withhold.
    ...(maySeeOffers
      ? [
          {
            href: `${basePath}?kind=offer`,
            label: 'Offers',
            count: counts.offers,
            on: kind === 'offer',
          },
        ]
      : []),
    { href: `${basePath}?kind=enquiry`, label: 'Enquiries', on: kind === 'enquiry' },
  ];

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.sub}>
          {subtitle ?? (
            <>
              Everyone who has asked about an address the agency holds.
              {maySeeOffers
                ? ' Private offers on properties you have sold appear here too.'
                : ''}
            </>
          )}
        </p>
      </div>

      <nav className={styles.tabs} aria-label="Lead kind">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`${styles.tab} ${t.on ? styles.tabOn : ''}`}
            aria-current={t.on ? 'page' : undefined}
          >
            {t.label}
            {t.count !== undefined ? <span className={styles.tabCount}>{t.count}</span> : null}
          </Link>
        ))}
      </nav>

      <div className={styles.card}>
        {rows.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>
              {kind === 'offer' ? 'No private offers yet' : 'Nothing here yet'}
            </p>
            <p className={styles.emptyHint}>
              {kind === 'offer'
                ? 'An offer arrives when somebody makes one on a property your agency has sold and that is no longer listed.'
                : 'Enquiries from the public site land here as soon as somebody sends one.'}
            </p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>From</th>
                <th>Property</th>
                <th>Offer</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Assigned to</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className={styles.who}>{r.name}</div>
                    <div className={styles.contact}>
                      <a href={`mailto:${r.email}`}>{r.email}</a>
                      {r.phone ? <> · <a href={`tel:${r.phone}`}>{r.phone}</a></> : null}
                    </div>
                  </td>
                  <td>
                    {/*
                      An offer links to the public property page, where the
                      sale history it was made against lives. An enquiry links
                      to the ad it came through: while live that is the listing,
                      and once sold the old URL redirects to wherever the
                      address is now (docs/adr/0013), so the link never dies.
                    */}
                    {r.kind === 'offer' || r.listingId ? (
                      <a
                        href={
                          r.kind === 'offer' || !r.listingId
                            ? `${webUrl}/property/${r.propertyId}`
                            : `${webUrl}/listing/${r.listingId}`
                        }
                        className={styles.addr}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {r.address}
                      </a>
                    ) : (
                      <span className={styles.addr}>{r.address}</span>
                    )}
                    {r.message ? <div className={styles.msg}>{r.message}</div> : null}
                  </td>
                  <td>
                    {/*
                      The figure the visitor typed, stored and rendered
                      verbatim. Nothing computes, rounds or compares it (#4).
                    */}
                    {r.offerAmount !== null ? (
                      <span className={styles.amount}>{AUD.format(r.offerAmount)}</span>
                    ) : (
                      <span className={styles.noAmount}>—</span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`${styles.badge} ${r.kind === 'offer' ? styles.kindOffer : styles.kindPlain}`}
                    >
                      {KIND_LABEL[r.kind]}
                    </span>
                  </td>
                  <td>
                    <LeadStatusControl leadId={r.id} status={r.status} mayUpdate={r.mayUpdate} />
                  </td>
                  <td>
                    <LeadAssignControl
                      leadId={r.id}
                      kind={r.kind}
                      assignedTo={r.assignedTo}
                      assigneeName={r.assigneeName}
                      assignees={assignees}
                    />
                  </td>
                  <td className={styles.when}>{WHEN.format(new Date(r.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
