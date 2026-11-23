'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState } from 'react';
import type { ChatActionDetail } from '@repo/core/recurring/detail-types';
import type { AutomationPaths } from '@repo/core/automation-status/links';
import styles from './automation-detail.module.css';

/**
 * Something approved once in this chat (the user, 2026-11-23): what it did and, for a send, how far it has got and who it reached,
 * person by person. Refreshes itself while it is on screen, faster while it is still going.
 */

const STATUS: Record<string, string> = { approved: 'Approved', scheduled: 'Scheduled', running: 'Running', done: 'Done', failed: 'Failed' };
const PERSON: Record<string, string> = { queued: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Skipped' };

function when(at: string | null): string {
  if (!at) return '';
  return new Date(at).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function ChatActionPanel({ actionKey, paths }: { actionKey: string; paths: AutomationPaths }) {
  const [d, setD] = useState<ChatActionDetail | null>(null);
  const [missing, setMissing] = useState(false);

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

  if (missing) return <p className={styles.muted}>This is no longer available.</p>;
  if (!d) return <p className={styles.muted}>Loading…</p>;

  const s = d.send;
  // Skipped people were never going to get it: progress is over the ones it is for.
  const meant = s ? s.total - s.skipped : 0;
  const percent = s && meant > 0 ? Math.min(100, Math.floor(((s.sent + s.failed) / meant) * 100)) : null;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h2 className={styles.name}>{d.name}</h2>
        <span className={styles.state} data-state={going ? 'active' : undefined}>
          {s && s.left > 0 && d.status === 'done' ? 'Sending' : (STATUS[d.status] ?? d.status)}
        </span>
      </div>
      {d.lines.length ? (
        <dl className={styles.facts}>
          {d.lines.map((l, i) => (
            <Fragment key={i}>
              <dt>{l.label}</dt>
              <dd>{l.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      <p className={styles.muted}>
        {d.decidedAt ? `Approved ${when(d.decidedAt)}` : ''}
        {d.status === 'scheduled' && d.runAt ? ` · runs ${when(d.runAt)}` : ''}
        {d.finishedAt ? ` · finished ${when(d.finishedAt)}` : ''}
      </p>
      {d.error ? <p className={`${styles.note} ${styles.bad}`}>{d.error}</p> : null}

      {s ? (
        <>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Progress</h3>
            {percent !== null ? (
              <>
                <span className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Progress">
                  <span className={styles.barFill} style={{ width: `${percent}%` }} />
                </span>
                <p className={styles.muted}>{percent}% done</p>
              </>
            ) : (
              <p className={styles.muted}>Nobody in it could be sent to.</p>
            )}
            <div className={styles.numbers}>
              <span>
                <b>{s.sent}</b> sent
              </span>
              {s.left ? (
                <span>
                  <b>{s.left}</b> left
                </span>
              ) : null}
              {s.failed ? (
                <span className={styles.bad}>
                  <b>{s.failed}</b> failed
                </span>
              ) : null}
              {s.skipped ? (
                <span>
                  <b>{s.skipped}</b> skipped
                </span>
              ) : null}
              <span className={styles.muted}>of {s.total}</span>
            </div>
            <Link href={`${s.channel === 'sms' ? paths.sms : paths.email}/${s.batchId}`} className={styles.link}>
              Open on Bulk {s.channel === 'sms' ? 'SMS' : 'email'}
            </Link>
          </section>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Who it went to</h3>
            <ul className={styles.runs}>
              {s.people.map((p, i) => (
                <li key={i}>
                  <div className={styles.runTop}>
                    <span>{p.name}</span>
                    <span className={styles.runStatus} data-status={p.status}>
                      {PERSON[p.status] ?? p.status}
                    </span>
                  </div>
                  <span className={styles.muted}>
                    {p.to ?? ''}
                    {p.at ? ` · ${when(p.at)}` : ''}
                  </span>
                  {p.why ? <span className={p.status === 'failed' ? `${styles.note} ${styles.bad}` : styles.note}>{p.why}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
