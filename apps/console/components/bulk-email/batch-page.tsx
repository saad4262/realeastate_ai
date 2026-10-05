import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { BATCH_STATUS_LABELS, getBatch, SKIP_REASON_LABELS, TemplateEmailError } from '@repo/core/template-email';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { ApproveSendButton, CancelBatchButton, RefreshWhileSending, RetryFailedButton } from './islands';

/**
 * One batch (docs/adr/0022): the FROZEN list in full before approval — the
 * count, every name, every skipped contact and why — the email as the first
 * person will get it, and the one Approve & Send.
 */
export async function BatchPage({ surface, id }: { surface: 'agency' | 'agent'; id: string }) {
  const session = await requireConsoleAccess(surface);
  const basePath = surface === 'agency' ? '/bulk-email' : '/my-bulk-email';
  const contactBase = surface === 'agency' ? '/customers' : '/my-contacts';
  const inbox = surface === 'agency' ? '/inbox' : '/my-inbox';
  let b: Awaited<ReturnType<typeof getBatch>>;
  try {
    b = await getBatch(getConsoleDb(), session.actor, id);
  } catch (err) {
    return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{err instanceof TemplateEmailError ? err.message : 'Failed to load the batch'}</p>;
  }
  const going = b.recipients.filter((r) => r.status !== 'skipped');
  const skipped = b.recipients.filter((r) => r.status === 'skipped');
  const STATUS = { queued: 'Will be sent', sending: 'Sending…', sent: 'Sent', failed: 'Failed', skipped: 'Skipped' } as const;

  return (
    <div className={contactStyles.wrap}>
      <RefreshWhileSending active={b.status === 'approved_sending'} />
      <Link href={basePath} className={contactStyles.back}>← Bulk email</Link>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>{b.template.name}</h1>
          <p className={contactStyles.sub}>
            {BATCH_STATUS_LABELS[b.status]} · filter “{b.filter.name}” · prepared <LocalTime iso={b.preparedAt.toISOString()} style="short" />
            {b.status === 'prepared' ? <> · expires <LocalTime iso={b.expiresAt.toISOString()} style="short" /></> : null}
            {b.agentName ? ` · ${b.agentName}` : ''}
          </p>
        </div>
        <div className={contactStyles.headActions}>
          {b.mayApprove ? <ApproveSendButton batchId={b.id} count={b.counts.toSend} /> : null}
          {b.mayCancel ? <CancelBatchButton batchId={b.id} /> : null}
          {b.mayRetry ? <RetryFailedButton batchId={b.id} count={b.counts.failed} /> : null}
        </div>
      </div>
      {b.status === 'expired' ? (
        <p className={contactStyles.error} role="alert">This batch expired 48 hours after it was prepared. Prepare it again to send.</p>
      ) : null}

      <div className={contactStyles.stats}>
        <div className={contactStyles.stat}><span className={contactStyles.statNum}>{b.counts.total}</span><span className={contactStyles.statLabel}>Matched the filter</span></div>
        <div className={contactStyles.stat}><span className={contactStyles.statNum}>{b.counts.toSend + b.counts.sent + b.counts.sending + b.counts.failed}</span><span className={contactStyles.statLabel}>To receive it</span></div>
        <div className={contactStyles.stat}><span className={contactStyles.statNum}>{b.counts.skipped}</span><span className={contactStyles.statLabel}>Skipped</span></div>
        <div className={contactStyles.stat}><span className={contactStyles.statNum}>{b.counts.sent}</span><span className={contactStyles.statLabel}>Sent</span></div>
      </div>

      {b.preview ? (
        <section className={contactStyles.card}>
          <div className={contactStyles.section} style={{ borderTop: 0 }}>
            <h2 className={contactStyles.sectionTitle}>The email, as {b.preview.to ?? 'the first person'} will get it</h2>
            <p style={{ margin: 0, fontWeight: 600 }}>{b.preview.subject}</p>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{b.preview.body}</pre>
            <p className={contactStyles.hint}>Plus the agency&apos;s sign-off, its postal address and an unsubscribe link.</p>
          </div>
        </section>
      ) : null}

      <section className={contactStyles.card}>
        <div className={contactStyles.section} style={{ borderTop: 0 }}>
          <h2 className={contactStyles.sectionTitle}>Recipients ({going.length})</h2>
          {going.length === 0 ? <p className={contactStyles.note}>Nobody — see who was skipped below.</p> : (
            <ul className={contactStyles.plainList}>
              {going.map((r) => (
                <li key={r.id} className={contactStyles.plainItem}>
                  <span>
                    <Link href={`${contactBase}/${r.contactId}`} className={contactStyles.name}>{r.name}</Link>
                    <span className={contactStyles.muted}> · {r.email}</span>
                  </span>
                  <span className={contactStyles.muted}>
                    {STATUS[r.status]}
                    {r.status === 'sent' && r.threadId ? <> · <Link href={`${inbox}?thread=${r.threadId}`}>conversation</Link></> : null}
                    {r.error ? ` · ${r.error}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className={contactStyles.section}>
          <h2 className={contactStyles.sectionTitle}>Skipped ({skipped.length})</h2>
          {skipped.length === 0 ? <p className={contactStyles.note}>Nobody was skipped.</p> : (
            <ul className={contactStyles.plainList}>
              {skipped.map((r) => (
                <li key={r.id} className={contactStyles.plainItem}>
                  <span>
                    <Link href={`${contactBase}/${r.contactId}`} className={contactStyles.name}>{r.name}</Link>
                    {r.email ? <span className={contactStyles.muted}> · {r.email}</span> : null}
                  </span>
                  <span className={contactStyles.muted}>
                    {r.skipReason ? SKIP_REASON_LABELS[r.skipReason] : 'Skipped'}
                    {r.skippedAtSend ? ' (found at the moment of sending)' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
