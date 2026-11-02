import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { BATCH_STATUS_LABELS, getBatch, TemplateEmailError } from '@repo/core/template-email';
import { smsParts } from '@repo/core/template-email/sms';
import { displayAu, loadSmsRules, nextSmsTime, SMS_SKIP_REASON_LABELS, type SmsSkipReason } from '@repo/core/phone';
import contactStyles from '@/components/contacts/contacts.module.css';
import { RefreshWhileSending } from '@/components/bulk-email/islands';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { ApproveSmsButton, CancelSmsButton, RetrySmsButton } from './islands';
import { hoursWords, smsBase } from './sms-page';

/**
 * One SMS batch (ADR 0074 part 2): the FROZEN list in full before approval — every name, the number each text
 * goes to and the number it goes from, every skipped person and why — the text as the first person will get
 * it (with the STOP line and what it costs in texts), and the one Approve & Send.
 */
export async function SmsBatchPage({ surface, id }: { surface: 'agency' | 'agent'; id: string }) {
  const session = await requireConsoleAccess(surface);
  const basePath = smsBase(surface);
  const contactBase = surface === 'agency' ? '/customers' : '/my-contacts';
  const db = getConsoleDb();
  let b: Awaited<ReturnType<typeof getBatch>>;
  let rules: Awaited<ReturnType<typeof loadSmsRules>>;
  try {
    [b, rules] = await Promise.all([getBatch(db, session.actor, id, new Date(), { channel: 'sms' }), loadSmsRules(db, session.actor.agencyId!)]);
  } catch (err) {
    return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{err instanceof TemplateEmailError ? err.message : 'Failed to load the texts'}</p>;
  }
  const going = b.recipients.filter((r) => r.status !== 'skipped');
  const skipped = b.recipients.filter((r) => r.status === 'skipped');
  const STATUS = { queued: 'Will be texted', sending: 'Sending…', sent: 'Sent', failed: 'Failed', skipped: 'Skipped' } as const;
  const now = new Date();
  const sendsAt = nextSmsTime(now, rules.hours, rules.timeZone);
  const laterWords = sendsAt.getTime() > now.getTime() ? sendsAt.toLocaleString('en-AU', { timeZone: rules.timeZone, weekday: 'long', hour: 'numeric', minute: '2-digit' }) : null;
  const parts = b.preview ? smsParts(b.preview.body) : null;
  const waiting = b.status === 'approved_sending' && b.counts.toSend > 0 && laterWords;

  return (
    <div className={contactStyles.wrap}>
      <RefreshWhileSending active={b.status === 'approved_sending' && !waiting} />
      <Link href={basePath} className={contactStyles.back}>← Bulk SMS</Link>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>{b.template.name}</h1>
          <p className={contactStyles.sub}>
            {BATCH_STATUS_LABELS[b.status]} · {b.filter.name} · prepared <LocalTime iso={b.preparedAt.toISOString()} style="short" />
            {b.status === 'prepared' ? <> · expires <LocalTime iso={b.expiresAt.toISOString()} style="short" /></> : null}
            {b.agentName ? ` · ${b.agentName}` : ''}
          </p>
        </div>
        <div className={contactStyles.headActions}>
          {b.mayApprove ? <ApproveSmsButton batchId={b.id} count={b.counts.toSend} laterWords={laterWords} /> : null}
          {b.mayCancel ? <CancelSmsButton batchId={b.id} /> : null}
          {b.mayRetry ? <RetrySmsButton batchId={b.id} count={b.counts.failed} /> : null}
        </div>
      </div>
      {b.status === 'expired' ? <p className={contactStyles.error} role="alert">These texts expired 48 hours after they were prepared. Prepare them again to send.</p> : null}
      {waiting ? (
        <p className={contactStyles.archivedBanner} role="note">
          Approved. Texts go only {hoursWords(rules.hours)}, so the rest go {laterWords}.
        </p>
      ) : null}

      <div className={contactStyles.stats}>
        <div className={contactStyles.stat}><span className={contactStyles.statNum}>{b.counts.total}</span><span className={contactStyles.statLabel}>Matched</span></div>
        <div className={contactStyles.stat}><span className={contactStyles.statNum}>{b.counts.toSend + b.counts.sent + b.counts.sending + b.counts.failed}</span><span className={contactStyles.statLabel}>To get it</span></div>
        <div className={contactStyles.stat}><span className={contactStyles.statNum}>{b.counts.skipped}</span><span className={contactStyles.statLabel}>Skipped</span></div>
        <div className={contactStyles.stat}><span className={contactStyles.statNum}>{b.counts.sent}</span><span className={contactStyles.statLabel}>Sent</span></div>
      </div>

      {b.preview ? (
        <section className={contactStyles.card}>
          <div className={contactStyles.section} style={{ borderTop: 0 }}>
            <h2 className={contactStyles.sectionTitle}>The text, as {b.preview.to ? displayAu(b.preview.to) : 'the first person'} will get it</h2>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{b.preview.body}</pre>
            {parts ? <p className={contactStyles.hint}>{parts.parts} {parts.parts === 1 ? 'text' : 'texts'} per person · {parts.units} characters. The STOP line is added to every text and cannot be removed.</p> : null}
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
                    <span className={contactStyles.muted}> · {displayAu(r.phone)}{r.fromE164 ? ` · from ${displayAu(r.fromE164)}` : ''}</span>
                  </span>
                  <span className={contactStyles.muted}>
                    {STATUS[r.status]}
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
                    {r.phone ? <span className={contactStyles.muted}> · {displayAu(r.phone)}</span> : null}
                  </span>
                  <span className={contactStyles.muted}>
                    {r.skipReason ? (SMS_SKIP_REASON_LABELS[r.skipReason as SmsSkipReason] ?? r.skipReason) : 'Skipped'}
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
