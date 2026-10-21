import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { emailActivity, parseEmailDays, type PlatformView } from '@repo/core/platform';
import { getConsoleDb } from '../../lib/db';
import { recordPlatformView } from '../../lib/require-platform-admin';
import { Stat } from './tables';
import styles from './admin.module.css';

/**
 * Email activity in the admin console (ADR 0051): what an agency, or one
 * member, sent and received — totals, by kind, by member, bulk email and the
 * latest messages. Delivery and opens are not tracked anywhere, so they are
 * not shown; "sent" means the mail provider accepted it.
 */

const KIND_LABEL: Record<string, string> = {
  conversation: 'Replies and new emails',
  template_email: 'Templates (bulk / workflows)',
  appointment_invitation: 'Meeting invitations',
};

const kindLabel = (k: string | null) => KIND_LABEL[k ?? 'conversation'] ?? (k ?? '').replace(/_/g, ' ');

export async function EmailsSection({
  view,
  base,
  params,
}: {
  view: PlatformView;
  base: string;
  params: Record<string, string | string[] | undefined>;
}) {
  await recordPlatformView(view.actor, 'emails');
  const raw = Array.isArray(params.days) ? params.days[0] : params.days;
  const days = parseEmailDays(raw);
  let a;
  try {
    a = await emailActivity(getConsoleDb(), view.actor, { days });
  } catch (err) {
    return (
      <p role="alert" className={styles.alert}>
        {err instanceof Error ? err.message : 'Could not load email activity'}
      </p>
    );
  }
  const t = a.totals;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.h2}>Email activity</h2>
          <p className={styles.sub}>
            {view.subject
              ? `What ${view.subject.name} sent, and the replies in their conversations.`
              : 'Everything the agency sent and received.'}{' '}
            “Sent” means the mail provider accepted it — delivery and opens are not tracked.
          </p>
        </div>
        <nav className={styles.tabs} aria-label="Period">
          {([7, 30, 90] as const).map((d) => (
            <Link key={d} href={`${base}/emails?days=${d}`} className={days === d ? styles.tabOn : styles.tab}>
              {d} days
            </Link>
          ))}
        </nav>
      </div>

      <div className={styles.stats}>
        <Stat label="Sent" value={t.sent} />
        <Stat label="Failed" value={t.failed} />
        <Stat label="Waiting to send" value={t.queued} />
        <Stat label="Received" value={t.received} />
        <Stat label="Replies" value={t.replies} />
        <Stat label="Sent through Gmail" value={t.viaGmail} />
      </div>

      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h3 className={styles.h2}>By kind</h3>
          </div>
          {a.byKind.length === 0 ? (
            <p className={styles.empty}>Nothing sent.</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr><th>Kind</th><th className={styles.num}>Sent</th><th className={styles.num}>Failed</th></tr>
              </thead>
              <tbody>
                {a.byKind.map((k) => (
                  <tr key={k.kind}>
                    <td>{kindLabel(k.kind)}</td>
                    <td data-label="Sent" className={styles.num}>{k.sent}</td>
                    <td data-label="Failed" className={styles.num}>{k.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        {view.subject ? null : (
          <section className={styles.card}>
            <div className={styles.cardBody}>
              <h3 className={styles.h2}>By member</h3>
            </div>
            {a.byMember.length === 0 ? (
              <p className={styles.empty}>Nobody sent anything.</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr><th>Member</th><th className={styles.num}>Sent</th><th className={styles.num}>Failed</th><th>Last</th></tr>
                </thead>
                <tbody>
                  {a.byMember.map((m) => (
                    <tr key={m.userId}>
                      <td>
                        <Link className={styles.name} href={`${base}/agents/${m.userId}/emails?days=${days}`}>{m.name}</Link>
                      </td>
                      <td data-label="Sent" className={styles.num}>{m.sent}</td>
                      <td data-label="Failed" className={styles.num}>{m.failed}</td>
                      <td data-label="Last">{m.lastSentAt ? <LocalTime iso={m.lastSentAt.toISOString()} /> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
      </div>

      <section className={styles.card}>
        <div className={styles.cardBody}>
          <h3 className={styles.h2}>Bulk email</h3>
        </div>
        {a.batches.length === 0 ? (
          <p className={styles.empty}>No bulk email in this period.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Template</th><th>By</th><th>Status</th><th className={styles.num}>Recipients</th>
                  <th className={styles.num}>Sent</th><th className={styles.num}>Failed</th><th className={styles.num}>Skipped</th><th>Prepared</th>
                </tr>
              </thead>
              <tbody>
                {a.batches.map((b) => (
                  <tr key={b.id}>
                    <td>{b.name}</td>
                    <td data-label="By">{b.byName}</td>
                    <td data-label="Status">
                      <span className={b.status === 'sent' ? styles.badgeGood : b.status === 'approved_sending' ? styles.badgeWarn : styles.badge}>
                        {b.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td data-label="Recipients" className={styles.num}>{b.recipients}</td>
                    <td data-label="Sent" className={styles.num}>{b.sent}</td>
                    <td data-label="Failed" className={styles.num}>{b.failed}</td>
                    <td data-label="Skipped" className={styles.num}>{b.skipped}</td>
                    <td data-label="Prepared"><LocalTime iso={b.preparedAt.toISOString()} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardBody}>
          <h3 className={styles.h2}>Latest emails</h3>
        </div>
        {a.recent.length === 0 ? (
          <p className={styles.empty}>No email in this period.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr><th>When</th><th>Way</th><th>Subject</th><th>From / to</th><th>Status</th></tr>
              </thead>
              <tbody>
                {a.recent.map((m) => (
                  <tr key={m.id}>
                    <td><LocalTime iso={m.at.toISOString()} /></td>
                    <td data-label="Way">
                      <span className={m.direction === 'in' ? styles.badgeWarn : styles.badge}>{m.direction === 'in' ? 'In' : 'Out'}</span>
                    </td>
                    <td data-label="Subject">
                      <Link className={styles.name} href={`${base}/inbox?thread=${m.threadId}`}>{m.subject || '(no subject)'}</Link>
                      <div className={styles.muted}>
                        {m.direction === 'out' ? kindLabel(m.kind) : 'Received'}
                        {m.sentVia ? ` · via ${m.sentVia}` : ''}
                      </div>
                    </td>
                    <td data-label="From / to">{m.direction === 'in' ? m.from : `${m.byName ?? 'The agency'} → ${m.to.join(', ')}`}</td>
                    <td data-label="Status">
                      <span className={m.status === 'failed' ? styles.badgeBad : m.status === 'sent' ? styles.badgeGood : styles.badge}>{m.status}</span>
                      {m.error ? <div className={styles.muted}>{m.error}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
