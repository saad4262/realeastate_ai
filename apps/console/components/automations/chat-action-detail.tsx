'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { readableDuration, sendTimeLeftMs, type ChatActionDetail } from '@repo/core/recurring/detail-types';
import type { AutomationPaths } from '@repo/core/automation-status/links';
import { Progress } from './progress';
import styles from './automation-detail.module.css';

/**
 * Something approved once in this chat (the user, 2026-11-23): what it did in a sentence, how far it has got and how long it took or
 * has left, and for a send every person with what happened to them. Refreshes itself while on screen, faster while it is going.
 */

type Person = NonNullable<ChatActionDetail['send']>['people'][number];
type Tone = 'good' | 'bad' | 'warn' | 'live' | 'wait';

const PERSON: Record<Person['status'], { label: string; tone: Tone }> = {
  failed: { label: 'Failed', tone: 'bad' },
  sending: { label: 'Sending', tone: 'live' },
  queued: { label: 'Waiting', tone: 'wait' },
  sent: { label: 'Sent', tone: 'good' },
  skipped: { label: 'Skipped', tone: 'wait' },
};
// What needs a look comes first.
const ORDER: Person['status'][] = ['failed', 'sending', 'queued', 'sent', 'skipped'];

const ICON: Record<string, string> = {
  send_template_email: 'mail',
  send_email: 'mail',
  send_template_sms: 'sms',
  schedule_appointment: 'event',
  reschedule_appointment: 'event',
  cancel_appointment: 'event_busy',
  schedule_team_meeting: 'groups',
  message_colleagues: 'forum',
  add_note: 'sticky_note_2',
  assign_contacts: 'person_add',
  assign_lead: 'person_add',
  invite_agent: 'person_add',
  create_dashboard: 'dashboard',
  update_dashboard: 'dashboard',
  create_listing_draft: 'home',
  update_listing: 'home',
  submit_listing: 'home',
  withdraw_listing: 'home',
  create_template: 'description',
};

function when(at: string | null): string {
  if (!at) return '';
  return new Date(at).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/** Its state in a word or two, and the colour it reads in. */
function stateOf(d: ChatActionDetail): { label: string; tone: Tone } {
  const s = d.send;
  if (d.status === 'failed') return { label: 'Failed', tone: 'bad' };
  if (d.status === 'scheduled') return { label: 'Scheduled', tone: 'wait' };
  if (s && s.left > 0) return { label: 'Sending', tone: 'live' };
  if (d.status === 'approved' || d.status === 'running') return { label: 'Running', tone: 'live' };
  if (s && s.failed > 0) return { label: `Done · ${s.failed} failed`, tone: 'warn' };
  return { label: 'Done', tone: 'good' };
}

/** What happened, in one plain sentence. */
function summaryOf(d: ChatActionDetail): string {
  const s = d.send;
  if (d.status === 'scheduled') return `Set to run ${when(d.runAt)}. Nothing has gone yet.`;
  if (!s) {
    if (d.status === 'failed') return d.error ?? 'This did not work.';
    if (d.status === 'done') return `Done ${when(d.finishedAt ?? d.decidedAt)}.`;
    return 'Working on it now.';
  }
  const meant = s.total - s.skipped;
  const who = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
  const parts = [s.left > 0 ? `Sending now: ${s.sent} of ${meant} sent so far.` : `Sent to ${s.sent} of the ${who(meant)} it was for.`];
  if (s.failed) parts.push(`${who(s.failed)} could not be sent to.`);
  if (s.skipped) parts.push(`${who(s.skipped)} ${s.skipped === 1 ? 'was' : 'were'} skipped before sending.`);
  return parts.join(' ');
}

export function ChatActionPanel({ actionKey, paths }: { actionKey: string; paths: AutomationPaths }) {
  const [d, setD] = useState<ChatActionDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [show, setShow] = useState<Person['status'] | 'all'>('all');

  const load = useCallback(async () => {
    const res = await fetch(`/api/automations?detail=${encodeURIComponent(actionKey)}`, { cache: 'no-store' }).catch(() => null);
    if (res?.status === 404) return setMissing(true);
    const body = res?.ok ? ((await res.json().catch(() => null)) as ChatActionDetail | null) : null;
    if (body) {
      setD(body);
      setMissing(false);
    }
  }, [actionKey]);

  const going = d ? d.status === 'approved' || d.status === 'scheduled' || d.status === 'running' || (d.send?.left ?? 0) > 0 : false;
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, going ? 5_000 : 30_000);
    return () => clearInterval(timer);
  }, [load, going]);

  if (missing) return <p className={`${styles.panel} ${styles.muted}`}>This is no longer available.</p>;
  if (!d) return <p className={`${styles.panel} ${styles.muted}`}>Loading…</p>;

  const s = d.send;
  const state = stateOf(d);
  const sentTimes = s ? s.people.map((p) => p.at).filter((t): t is string => Boolean(t)).sort() : [];
  const startedAt = sentTimes[0] ?? null;
  const endedAt = s ? (s.left > 0 ? null : (sentTimes[sentTimes.length - 1] ?? d.finishedAt)) : d.finishedAt;
  const left = s ? sendTimeLeftMs(sentTimes, s.left) : null;
  const tookFrom = startedAt ?? d.decidedAt;
  const took = tookFrom && endedAt ? readableDuration(new Date(endedAt).getTime() - new Date(tookFrom).getTime()) : null;

  const counts = s ? ORDER.map((k) => [k, s.people.filter((p) => p.status === k).length] as const).filter(([, n]) => n > 0) : [];
  const people = s ? [...s.people].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)).filter((p) => show === 'all' || p.status === show) : [];

  return (
    <div className={styles.panel}>
      <header className={styles.hero}>
        <span className={styles.heroIcon} aria-hidden>
          {ICON[d.tool] ?? 'task_alt'}
        </span>
        <div className={styles.heroText}>
          <h2 className={styles.name}>{d.name}</h2>
          <span className={styles.pill} data-tone={state.tone}>
            {state.label}
          </span>
        </div>
      </header>
      <p className={styles.summary}>{summaryOf(d)}</p>

      {s ? (
        <section className={styles.card}>
          <Progress sent={s.sent} failed={s.failed} skipped={s.skipped} left={s.left} timeLeft={left === null ? null : readableDuration(left)} />
          <Link href={`${s.channel === 'sms' ? paths.sms : paths.email}/${s.batchId}`} className={styles.link}>
            Open on Bulk {s.channel === 'sms' ? 'SMS' : 'email'} →
          </Link>
        </section>
      ) : null}

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Timeline</h3>
        <ol className={styles.timeline}>
          <li data-done={d.decidedAt ? '' : undefined}>
            <span>Approved</span>
            <span className={styles.muted}>{when(d.decidedAt) || '—'}</span>
          </li>
          {d.status === 'scheduled' ? (
            <li>
              <span>Runs</span>
              <span className={styles.muted}>{when(d.runAt)}</span>
            </li>
          ) : null}
          {s ? (
            <li data-done={startedAt ? '' : undefined}>
              <span>First sent</span>
              <span className={styles.muted}>{when(startedAt) || 'Not yet'}</span>
            </li>
          ) : null}
          <li data-done={endedAt ? '' : undefined}>
            <span>Finished</span>
            <span className={styles.muted}>{endedAt ? `${when(endedAt)}${took ? ` · took ${took}` : ''}` : left !== null ? `About ${readableDuration(left)} left` : 'Not yet'}</span>
          </li>
        </ol>
        {d.error && s ? <p className={styles.errorBox}>{d.error}</p> : null}
      </section>

      {d.lines.length ? (
        <details className={styles.section} open={!s}>
          <summary className={styles.sectionTitle}>What was approved</summary>
          <dl className={styles.facts}>
            {d.lines.map((l, i) => (
              <Fragment key={i}>
                <dt>{l.label}</dt>
                <dd>{l.value}</dd>
              </Fragment>
            ))}
          </dl>
        </details>
      ) : null}

      {s && s.people.length ? (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>
            {s.channel === 'sms' ? 'Who it was texted to' : 'Who it was sent to'} · {s.total}
          </h3>
          {counts.length > 1 ? (
            <div className={styles.chips} role="group" aria-label="Show">
              <button type="button" className={styles.chip} aria-pressed={show === 'all'} onClick={() => setShow('all')}>
                All {s.total}
              </button>
              {counts.map(([k, n]) => (
                <button key={k} type="button" className={styles.chip} data-tone={PERSON[k].tone} aria-pressed={show === k} onClick={() => setShow(k)}>
                  {PERSON[k].label} {n}
                </button>
              ))}
            </div>
          ) : null}
          <ul className={styles.people}>
            {people.map((p, i) => (
              <li key={`${p.name}-${i}`} className={styles.person}>
                <span className={styles.avatar} aria-hidden>
                  {initials(p.name)}
                </span>
                <div className={styles.personText}>
                  <div className={styles.personTop}>
                    <span className={styles.personName}>{p.name}</span>
                    <span className={styles.pill} data-tone={PERSON[p.status].tone}>
                      {PERSON[p.status].label}
                    </span>
                  </div>
                  <span className={styles.personSub}>
                    {p.to ?? (s.channel === 'sms' ? 'No mobile' : 'No email')}
                    {p.at ? ` · ${when(p.at)}` : ''}
                  </span>
                  {p.why ? <p className={p.status === 'failed' ? styles.errorBox : styles.reason}>{p.why}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
