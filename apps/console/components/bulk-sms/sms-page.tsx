import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { BATCH_STATUS_LABELS, listBatches, listMyFilters, listTemplates, SMS_BATCH_MAX, TemplateEmailError } from '@repo/core/template-email';
import { loadSmsRules } from '@repo/core/phone';
import { isPairedSkillOn } from '@repo/core/skill-switches';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { PrepareSmsForm } from './islands';

export const smsBase = (surface: 'agency' | 'agent') => (surface === 'agency' ? '/bulk-sms' : '/my-bulk-sms');

/** "9 am to 8 pm". */
export function hoursWords([from, to]: [number, number]): string {
  const h = (n: number) => (n === 0 || n === 24 ? 'midnight' : n === 12 ? 'noon' : `${((n + 11) % 12) + 1} ${n < 12 ? 'am' : 'pm'}`);
  return `${h(from)} to ${h(to)}`;
}

/**
 * Bulk SMS (ADR 0074 part 2): prepare texts from an SMS template and a saved filter, the batches (an agent's
 * own; an owner or admin sees the agency's), and the SMS templates. Shared by `/bulk-sms` and `/my-bulk-sms`.
 */
export async function BulkSmsPage({ surface }: { surface: 'agency' | 'agent' }) {
  const session = await requireConsoleAccess(surface);
  const basePath = smsBase(surface);
  const db = getConsoleDb();
  const actor = session.actor;
  let data: [Awaited<ReturnType<typeof listBatches>>, Awaited<ReturnType<typeof listTemplates>>, Awaited<ReturnType<typeof listMyFilters>>, Awaited<ReturnType<typeof loadSmsRules>>, boolean];
  try {
    data = await Promise.all([
      listBatches(db, actor, new Date(), { channel: 'sms' }),
      listTemplates(db, actor, { channel: 'sms' }),
      listMyFilters(db, actor),
      loadSmsRules(db, actor.agencyId!),
      isPairedSkillOn(db, actor.agencyId!, actor.userId, actor.membershipRole, 'bulk_sms'),
    ]);
  } catch (err) {
    return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{err instanceof TemplateEmailError ? err.message : 'Failed to load Bulk SMS'}</p>;
  }
  const [batches, { templates, mayDraft }, filters, rules, skillOn] = data;
  const usable = templates.filter((t) => t.mayUse);
  const skills = surface === 'agency' ? '/skills' : '/my-skills';

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.headText}>
        <h1 className={contactStyles.title}>Bulk SMS</h1>
        <p className={contactStyles.sub}>
          An SMS template to the contacts in one of your saved filters, from each contact&apos;s agent&apos;s number (else the agency
          number). Only people who agreed to marketing, enquired in the last 24 months, or are a seller, landlord or tenant — with an
          Australian mobile, and never anyone who replied STOP. Texts go {hoursWords(rules.hours)}; approved outside those hours,
          they wait for the morning. {SMS_BATCH_MAX} people a batch. Prepare, check every name, then Approve &amp; Send.
        </p>
      </div>
      {!skillOn ? (
        <p className={contactStyles.archivedBanner} role="note">
          “Bulk SMS” is off in <Link href={skills}>Skills</Link> — it needs the agency&apos;s switch{surface === 'agent' ? ' and your own' : ''}. You can write templates; preparing and sending wait until it is on.
        </p>
      ) : null}
      {!rules.numbers.size ? (
        <p className={contactStyles.archivedBanner} role="note">
          No phone numbers yet — texts go from each agent&apos;s Twilio number. Connect Twilio under Connectors → Phone &amp; SMS first.
        </p>
      ) : null}

      <section className={contactStyles.card}>
        <div className={contactStyles.section} style={{ borderTop: 0 }}>
          <h2 className={contactStyles.sectionTitle}>Prepare texts</h2>
          <PrepareSmsForm basePath={basePath} templates={usable.map((t) => ({ id: t.id, name: t.name }))} filters={filters.map((f) => ({ id: f.id, name: f.name }))} />
        </div>
      </section>

      <section className={contactStyles.card}>
        <div className={contactStyles.section} style={{ borderTop: 0 }}>
          <h2 className={contactStyles.sectionTitle}>Batches</h2>
          {batches.length === 0 ? (
            <p className={contactStyles.note}>None yet.</p>
          ) : (
            <ul className={contactStyles.plainList}>
              {batches.map((b) => (
                <li key={b.id} className={contactStyles.plainItem}>
                  <span style={{ display: 'grid', gap: '0.15rem' }}>
                    <Link href={`${basePath}/${b.id}`} className={contactStyles.name}>{b.templateName}</Link>
                    <span className={contactStyles.muted}>
                      {b.filterName} · {BATCH_STATUS_LABELS[b.status]}
                      {b.agentName && surface === 'agency' ? ` · ${b.agentName}` : ''} · prepared <LocalTime iso={b.preparedAt.toISOString()} style="short" />
                    </span>
                  </span>
                  <span className={contactStyles.muted}>
                    {b.counts.sent ? `${b.counts.sent} sent · ` : ''}
                    {b.counts.toSend ? `${b.counts.toSend} to send · ` : ''}
                    {b.counts.skipped} skipped
                    {b.counts.failed ? ` · ${b.counts.failed} failed` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className={contactStyles.card}>
        <div className={contactStyles.section} style={{ borderTop: 0 }}>
          <div className={contactStyles.inlineForm} style={{ justifyContent: 'space-between' }}>
            <h2 className={contactStyles.sectionTitle}>SMS templates</h2>
            {mayDraft ? <Link href={`${basePath}/templates/new`} className={contactStyles.btnGhost}>+ New SMS template</Link> : null}
          </div>
          {templates.length === 0 ? (
            <p className={contactStyles.note}>No SMS templates yet. People write them; the AI never does.</p>
          ) : (
            <ul className={contactStyles.plainList}>
              {templates.map((t) => (
                <li key={t.id} className={contactStyles.plainItem}>
                  <span style={{ display: 'grid', gap: '0.15rem' }}>
                    <Link href={`${basePath}/templates/${t.id}`} className={contactStyles.name}>{t.name}</Link>
                    <span className={contactStyles.muted}>{t.body.length > 90 ? `${t.body.slice(0, 90)}…` : t.body}</span>
                  </span>
                  <span className={t.agencyWide ? contactStyles.chip : contactStyles.chipInferred}>
                    {t.agencyWide ? 'Agency' : t.mayUse ? 'Only you' : `${t.authorName ?? 'An agent'}’s own`}
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
