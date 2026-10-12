import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { getMySkill, getSkillRun, SkillError, type RecordLink, type SkillItem, type SkillResult } from '@repo/core/skills';
import contactStyles from '@/components/contacts/contacts.module.css';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { getConsoleDb } from '../../lib/db';

/**
 * One run's result (docs/adr/0021). Lists, times and counts are SQL's; the
 * assistant's text is labelled, and each [A1] in it is a link to the record
 * it cites. Times are the viewer's own clock.
 */
export async function SkillRunPage({ surface, id, runId }: { surface: 'agency' | 'agent'; id: string; runId: string }) {
  const session = await requireConsoleAccess(surface);
  const basePath = surface === 'agency' ? '/skills' : '/my-skills';
  const paths = surface === 'agency'
    ? { contact: '/customers', inbox: '/inbox', leads: '/leads', calendar: '/calendar' }
    : { contact: '/my-contacts', inbox: '/my-inbox', leads: '/my-leads', calendar: '/my-calendar' };
  const db = getConsoleDb();
  let data: [Awaited<ReturnType<typeof getMySkill>>, Awaited<ReturnType<typeof getSkillRun>>];
  try {
    data = await Promise.all([getMySkill(db, session.actor, id), getSkillRun(db, session.actor, id, runId)]);
  } catch (err) {
    return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{err instanceof SkillError ? err.message : 'Failed to load the result'}</p>;
  }
  const [s, run] = data;
  const result = run.result as SkillResult | null;

  const hrefFor = (l: RecordLink): string => {
    switch (l.type) {
      // A team meeting (no contact, ADR 0038) lives on the calendar.
      case 'appointment': return l.contactId ? `${paths.contact}/${l.contactId}?tab=calendar` : paths.calendar;
      case 'contact': return `${paths.contact}/${l.id}`;
      case 'thread': return `${paths.inbox}?thread=${l.id}`;
      case 'lead': return l.threadId ? `${paths.inbox}?thread=${l.threadId}` : paths.leads;
    }
  };
  const items: SkillItem[] = !result ? [] : result.kind === 'morning_brief'
    ? [...result.sections.appointments, ...result.sections.nextActions, ...result.sections.emails, ...result.sections.leads]
    : result.items;
  const byRef = new Map(items.map((i) => [i.ref, i]));

  /** The assistant's text with each [A1] turned into a link to its record. */
  const cited = (text: string) =>
    text.split(/(\[[A-Z]\d{1,3}\])/g).map((part, i) => {
      const ref = /^\[([A-Z]\d{1,3})\]$/.exec(part)?.[1];
      const item = ref ? byRef.get(ref) : undefined;
      return item ? (
        <Link key={i} href={hrefFor(item.link)} className={contactStyles.chip} title={item.title}>{ref}</Link>
      ) : (
        <span key={i}>{part}</span>
      );
    });

  const Section = ({ title, list, showTime }: { title: string; list: SkillItem[]; showTime?: boolean }) =>
    list.length ? (
      <div className={contactStyles.section}>
        <h2 className={contactStyles.sectionTitle}>{title}</h2>
        <ul className={contactStyles.plainList}>
          {list.map((i) => (
            <li key={i.ref} className={contactStyles.plainItem}>
              <span>
                <span className={contactStyles.chipInferred}>{i.ref}</span>{' '}
                <Link href={hrefFor(i.link)} className={contactStyles.name}>{i.title}</Link>
                {i.detail ? <span className={contactStyles.muted}> — {i.detail}</span> : null}
              </span>
              {showTime && i.at ? <span className={contactStyles.muted}><LocalTime iso={i.at} style="short" /></span> : null}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <div className={contactStyles.wrap}>
      <Link href={`${basePath}/${s.id}`} className={contactStyles.back}>← {s.name}</Link>
      <div className={contactStyles.headText}>
        <h1 className={contactStyles.title}>{s.name}</h1>
        <p className={contactStyles.sub}>
          <LocalTime iso={run.startedAt.toISOString()} /> · {run.trigger === 'manual' ? 'Run now' : 'Scheduled'} ·{' '}
          {run.status === 'succeeded' ? 'Done' : run.status === 'skipped' ? 'Skipped' : run.status === 'failed' ? 'Failed' : 'Running'}
          {run.costUsd > 0 ? ` · cost US$${run.costUsd.toFixed(4)}` : ''}
          {run.emailedAt ? ' · emailed to you' : ''}
        </p>
      </div>
      {run.error ? <p className={contactStyles.error} role="alert">{run.error}</p> : null}

      {result ? (
        <div className={contactStyles.card}>
          {run.summary ? (
            <div className={contactStyles.section} style={{ borderTop: 0 }}>
              <h2 className={contactStyles.sectionTitle}>
                {run.summarySource === 'model' ? 'Written by the AI assistant from your records' : 'Summary'}
              </h2>
              <p style={{ margin: 0, lineHeight: 1.6 }}>{cited(run.summary)}</p>
            </div>
          ) : null}
          {result.kind === 'morning_brief' ? (
            <>
              <Section title="Today's appointments" list={result.sections.appointments} showTime />
              <Section title="Overdue next actions" list={result.sections.nextActions} showTime />
              <Section title="Waiting for your answer" list={result.sections.emails} showTime />
              <Section title="New leads (last 24 hours)" list={result.sections.leads} showTime />
            </>
          ) : (
            <div className={contactStyles.section} style={run.summary ? undefined : { borderTop: 0 }}>
              <h2 className={contactStyles.sectionTitle}>
                {run.summarySource === 'model' ? 'Ranked by the AI assistant — each reason is about that email' : 'Offers first, then whoever has waited longest'}
              </h2>
              <ol style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.6rem', fontSize: '0.875rem' }}>
                {result.items.map((i) => (
                  <li key={i.ref}>
                    <Link href={hrefFor(i.link)} className={contactStyles.name}>{i.title}</Link>
                    <span className={contactStyles.muted}> — {i.detail}</span>
                    {i.at ? <span className={contactStyles.muted}> · <LocalTime iso={i.at} style="short" /></span> : null}
                    <div className={contactStyles.note}>{i.reason ?? (i.offer ? 'Private offer.' : 'Waiting for a reply.')}</div>
                  </li>
                ))}
              </ol>
              {result.dropped ? <p className={contactStyles.hint}>{result.dropped} line(s) of the assistant&apos;s answer did not match a conversation and were left out.</p> : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
