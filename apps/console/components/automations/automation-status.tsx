'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { automationHref, type AutomationItem, type AutomationPaths, type AutomationStatus } from '@repo/core/automation-status/links';
import { useToast } from '@/components/toast';
import { stopAutomationRunAction, stopTaskAction } from '@/lib/automation-actions';
import { usePanelDismiss } from './use-panel';
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
  if (item.kind === 'automation_run') return 'Automation';
  if (item.kind === 'send_plan') return 'Bulk email, in parts';
  if (item.kind === 'batch') return item.channel === 'sms' ? 'Bulk SMS' : 'Bulk email';
  return item.kind === 'task' ? 'Task' : 'AI skill';
}

function progressWords(item: AutomationItem): string {
  const next = item.nextAt ? ` · next ${time(item.nextAt)}` : '';
  if (item.kind === 'send_plan' && item.parts) {
    return `${item.done} of ${item.total} sent${item.failed ? ` · ${item.failed} failed` : ''} · part ${Math.min(item.parts.done + 1, item.parts.total)} of ${item.parts.total}${next}`;
  }
  if (item.kind === 'automation_run') {
    if (item.state === 'done') return `Complete · ${item.done} sent${item.failed ? ` · ${item.failed} failed` : ''}${item.nextAt ? ` · next ${time(item.nextAt)}` : ''}`;
    return item.total ? `${item.done} of ${item.total} sent${item.failed ? ` · ${item.failed} failed` : ''}` : 'Starting…';
  }
  if (item.kind === 'batch') return `${item.done} of ${item.total} sent${item.failed ? ` · ${item.failed} failed` : ''}`;
  if (item.kind === 'task') return `${item.done} of ${item.total} steps done${next}`;
  return item.state === 'running' ? 'Running now' : 'Did not finish';
}

function RowLink({ href, onNavigate, children }: { href: string | null; onNavigate: () => void; children: React.ReactNode }) {
  return href ? (
    <Link href={href} className={`${styles.row} ${styles.rowGrow}`} onClick={onNavigate}>
      {children}
    </Link>
  ) : (
    <div className={`${styles.row} ${styles.rowGrow}`}>{children}</div>
  );
}

type Controls = { paths: AutomationPaths; onNavigate: () => void; reload: () => Promise<void> };

/** One button that does one thing, says why when it is refused, and refreshes the panel. */
function ActionButton({ label, run, reload }: { label: string; run: () => Promise<{ ok: boolean; error?: string }>; reload: () => Promise<void> }) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const click = async () => {
    setPending(true);
    const r = await run().catch(() => ({ ok: false, error: 'That did not work. Please try again.' }));
    if (!r.ok) toast({ title: 'Not changed', description: r.error ?? '', variant: 'error' });
    await reload();
    setPending(false);
  };
  return (
    <button type="button" className={styles.controlBtn} disabled={pending} onClick={() => void click()}>
      {pending ? '…' : label}
    </button>
  );
}

/** Stopping cannot be undone, so it asks first, in the row. */
function StopControl({ item, reload }: { item: AutomationItem; reload: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={styles.controlBtn} onClick={() => setAsking(true)}>
        Stop
      </button>
    );
  }
  return (
    <div className={styles.confirm}>
      <span className={styles.note}>Stop the rest? What has gone stays gone.</span>
      <ActionButton label="Stop" run={() => (item.kind === 'automation_run' ? stopAutomationRunAction(item.targetId) : stopTaskAction(item.targetId))} reload={reload} />
      <button type="button" className={styles.controlBtn} onClick={() => setAsking(false)}>
        Keep going
      </button>
    </div>
  );
}

function ItemRow({ item, paths, onNavigate, reload }: { item: AutomationItem } & Controls) {
  const percent = item.total > 0 ? Math.min(100, Math.floor((item.done / item.total) * 100)) : null;
  return (
    <li className={styles.rowStack}>
      <RowLink href={automationHref(item, paths)} onNavigate={onNavigate}>
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
      {item.canStop ? (
        <div className={styles.rowActions}>
          <StopControl item={item} reload={reload} />
        </div>
      ) : null}
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

export function AutomationStatusButton({ paths, className, glyphClassName, textClassName }: { paths: AutomationPaths; className?: string; glyphClassName?: string; textClassName?: string }) {
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
    return () => clearInterval(timer);
  }, [open, loadStatus]);

  const close = useCallback(() => setOpen(false), []);
  usePanelDismiss(open, close, wrap);
  const nothing = status && !status.running.length && !status.failed.length && !status.finished.length;
  const controls = { paths, onNavigate: close, reload: loadStatus };

  return (
    <div className={styles.wrap} ref={wrap}>
      <button type="button" className={className} aria-label={count ? `Automations, ${count} running` : 'Automations'} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <span className={glyphClassName} aria-hidden>
          bolt
        </span>
        <span className={textClassName}>Automations</span>
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
          {nothing ? <p className={styles.empty}>Nothing is running right now.</p> : null}

          {status?.running.length ? (
            <section>
              <h3 className={styles.group}>Running now</h3>
              <ul className={styles.list}>{status.running.map((i) => <ItemRow key={i.key} item={i} {...controls} />)}</ul>
            </section>
          ) : null}
          {status?.failed.length ? (
            <section>
              <h3 className={styles.group}>Needs a look · last 24 hours</h3>
              <ul className={styles.list}>{status.failed.map((i) => <ItemRow key={i.key} item={i} {...controls} />)}</ul>
            </section>
          ) : null}
          {status?.finished.length ? (
            <section>
              <h3 className={styles.group}>Done in the last 24 hours</h3>
              <ul className={styles.list}>{status.finished.map((i) => <ItemRow key={i.key} item={i} {...controls} />)}</ul>
            </section>
          ) : null}
          <Link href={`${paths.skills}?tab=automations`} className={styles.seeAll} onClick={close}>
            See all automations
          </Link>

          {status?.usage ? <UsageLine usage={status.usage} /> : null}
        </div>
      ) : null}
    </div>
  );
}
