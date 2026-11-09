'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { automationHref, type ActiveAutomation, type AutomationItem, type AutomationPaths, type AutomationStatus } from '@repo/core/automation-status/links';
import styles from './automation-status.module.css';

/**
 * What is running now (ADR 0088), a client island in the top bar beside the bell: the bell says what has
 * happened, this says what is happening. The badge is asked once a minute; the list only while the panel
 * is open. Both are plain GETs, for the reason in live-refresh.tsx.
 */

const COUNT_MS = 60_000;
const OPEN_MS = 8_000;

function time(at: string): string {
  const d = new Date(at);
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('en-AU', today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function kindWord(item: AutomationItem): string {
  if (item.kind === 'batch') return item.channel === 'sms' ? 'Bulk SMS' : 'Bulk email';
  return item.kind === 'task' ? 'Task' : 'AI skill';
}

function progressWords(item: AutomationItem): string {
  if (item.kind === 'batch') return `${item.done} of ${item.total} sent${item.failed ? ` · ${item.failed} failed` : ''}`;
  if (item.kind === 'task') return `${item.done} of ${item.total} steps done${item.nextAt ? ` · next ${time(item.nextAt)}` : ''}`;
  return item.state === 'running' ? 'Running now' : 'Did not finish';
}

function RowLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  return href ? (
    <Link href={href} className={styles.row}>
      {children}
      <span className={styles.chevron} aria-hidden>
        chevron_right
      </span>
    </Link>
  ) : (
    <div className={styles.row}>{children}</div>
  );
}

function ItemRow({ item, paths }: { item: AutomationItem; paths: AutomationPaths }) {
  const percent = item.total > 0 ? Math.min(100, Math.floor((item.done / item.total) * 100)) : null;
  return (
    <li>
      <RowLink href={automationHref(item, paths)}>
        <span className={styles.dot} data-state={item.state} aria-hidden />
        <span className={styles.rowText}>
          <span className={styles.title}>{item.title}</span>
          <span className={styles.note}>
            {kindWord(item)}
            {item.subtitle ? ` · ${item.subtitle}` : ''}
            {item.owner ? ` · ${item.owner}` : ''}
          </span>
          {item.state === 'running' && percent !== null ? (
            <span className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={item.title}>
              <span className={styles.barFill} style={{ width: `${percent}%` }} />
            </span>
          ) : null}
          <span className={styles.note}>{item.error ?? progressWords(item)}</span>
        </span>
      </RowLink>
    </li>
  );
}

function ActiveRow({ item, paths }: { item: ActiveAutomation; paths: AutomationPaths }) {
  const when = item.nextAt ? `Next ${time(item.nextAt)}` : item.lastAt ? `Last ran ${time(item.lastAt)}` : item.kind === 'workflow' ? 'Waiting for its trigger' : 'Not scheduled';
  return (
    <li>
      <RowLink href={automationHref(item, paths)}>
        <span className={styles.rowText}>
          <span className={styles.title}>{item.title}</span>
          <span className={styles.note}>
            {item.kind === 'workflow' ? 'Workflow' : 'AI skill'}
            {item.owner ? ` · ${item.owner}` : ''} · {when}
          </span>
        </span>
      </RowLink>
    </li>
  );
}

function UsageLine({ usage }: { usage: NonNullable<AutomationStatus['usage']> }) {
  return (
    <p className={styles.usage}>
      Last 24 hours: Email {usage.email.person.used}/{usage.email.person.limit}
      {usage.sms ? ` · SMS ${usage.sms.used}/${usage.sms.limit}` : ''} · AI {usage.ai.percent}%
    </p>
  );
}

export function AutomationStatusButton({ paths, className, glyphClassName }: { paths: AutomationPaths; className?: string; glyphClassName?: string }) {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const loadCount = useCallback(async () => {
    const res = await fetch('/api/automations?count=1', { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return;
    const body = (await res.json().catch(() => null)) as { count?: number } | null;
    if (typeof body?.count === 'number') setCount(body.count);
  }, []);

  const loadStatus = useCallback(async () => {
    const res = await fetch('/api/automations', { cache: 'no-store' }).catch(() => null);
    const body = res?.ok ? ((await res.json().catch(() => null)) as AutomationStatus | null) : null;
    setFailed(!body);
    if (body) {
      setStatus(body);
      setCount(body.running.length);
    }
  }, []);

  useEffect(() => {
    void loadCount();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadCount();
    }, COUNT_MS);
    return () => clearInterval(timer);
  }, [loadCount]);

  useEffect(() => {
    if (!open) return;
    void loadStatus();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadStatus();
    }, OPEN_MS);
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      clearInterval(timer);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, loadStatus]);

  const close = () => setOpen(false);
  const nothing = status && !status.running.length && !status.failed.length && !status.active.length;

  return (
    <div className={styles.wrap} ref={wrap}>
      <button type="button" className={className} aria-label={count ? `Automations, ${count} running` : 'Automations'} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <span className={glyphClassName} aria-hidden>
          bolt
        </span>
        {count ? <span className={styles.badge}>{count > 9 ? '9+' : count}</span> : null}
      </button>

      {open ? (
        <div className={styles.panel} role="dialog" aria-label="Automations">
          <div className={styles.head}>
            <h2 className={styles.heading}>Automations</h2>
            {status?.running.length ? <span className={styles.note}>{status.running.length} running</span> : null}
          </div>

          {failed && !status ? <p className={styles.empty}>This could not be loaded. It will try again.</p> : null}
          {!failed && !status ? <p className={styles.empty}>Loading…</p> : null}
          {nothing ? <p className={styles.empty}>Nothing is running, and nothing is switched on yet.</p> : null}

          {/* A click on a row goes to a page: the panel closes with it. */}
          <div onClick={(e) => { if ((e.target as HTMLElement).closest('a')) close(); }}>
            {status?.running.length ? (
              <section>
                <h3 className={styles.group}>Running now</h3>
                <ul className={styles.list}>{status.running.map((i) => <ItemRow key={i.key} item={i} paths={paths} />)}</ul>
              </section>
            ) : null}
            {status?.failed.length ? (
              <section>
                <h3 className={styles.group}>Needs a look · last 24 hours</h3>
                <ul className={styles.list}>{status.failed.map((i) => <ItemRow key={i.key} item={i} paths={paths} />)}</ul>
              </section>
            ) : null}
            {status?.active.length ? (
              <section>
                <h3 className={styles.group}>Active</h3>
                <ul className={styles.list}>{status.active.map((i) => <ActiveRow key={i.key} item={i} paths={paths} />)}</ul>
              </section>
            ) : null}
            <Link href={`${paths.skills}?tab=automations`} className={styles.seeAll}>
              See all{status && status.activeTotal > status.active.length ? ` (${status.activeTotal} active)` : ''}
            </Link>
          </div>

          {status?.usage ? <UsageLine usage={status.usage} /> : null}
        </div>
      ) : null}
    </div>
  );
}
