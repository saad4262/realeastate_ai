'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationList, NotificationView } from '@repo/core/notifications';
import { useToast } from '@/components/toast';
import { listNotificationsAction, markNotificationsReadAction } from '@/lib/notification-actions';
import styles from './notification-bell.module.css';

/**
 * The console bell (ADR 0032 §4) — a client island in the otherwise server
 * shells, because it is the one thing on the page that must change while the
 * page sits open: a meeting reminder arrives from the cron, not from a click.
 *
 * It polls once a minute while the tab is visible (and once when it becomes
 * visible again), which is cheap — one indexed statement — and needs no push
 * infrastructure. A reminder that is new since the last poll also pops a
 * toast with a Join button, so a person working in another screen sees it.
 */

const POLL_MS = 60_000;

function ago(at: Date): string {
  const mins = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

export function NotificationBell({
  className,
  glyphClassName,
  placement = 'top',
}: {
  className?: string;
  glyphClassName?: string;
  /** 'sidebar': the panel opens upwards (the agent desk's bell sits at the bottom of the sidebar). */
  placement?: 'top' | 'sidebar';
}) {
  const { toast } = useToast();
  const [data, setData] = useState<NotificationList>({ rows: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const next = await listNotificationsAction();
    setData(next);
    // The first load only remembers what is there; later loads toast what is new.
    if (seen.current) {
      for (const n of next.rows) {
        if (!seen.current.has(n.id) && !n.readAt) {
          toast({
            title: n.title,
            ...(n.body ? { description: n.body } : {}),
            variant: 'info',
            duration: 0,
            ...(n.joinUrl ? { action: { label: 'Join', onClick: () => window.open(n.joinUrl!, '_blank', 'noopener') } } : {}),
          });
        }
      }
    }
    seen.current = new Set(next.rows.map((n) => n.id));
  }, [toast]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const markRead = async (ids: string[] | 'all') => {
    setData((d) => ({
      rows: d.rows.map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? new Date() } : n)),
      unread: ids === 'all' ? 0 : Math.max(0, d.unread - d.rows.filter((n) => ids.includes(n.id) && !n.readAt).length),
    }));
    await markNotificationsReadAction(ids);
  };

  return (
    <div className={styles.wrap} ref={wrap} data-placement={placement}>
      <button
        type="button"
        className={className ?? styles.button}
        aria-label={data.unread ? `Notifications, ${data.unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={glyphClassName ?? styles.glyph} aria-hidden>
          notifications
        </span>
        {data.unread ? <span className={styles.badge}>{data.unread > 9 ? '9+' : data.unread}</span> : null}
      </button>

      {open ? (
        <div className={styles.panel} role="dialog" aria-label="Notifications">
          <div className={styles.head}>
            <span className={styles.heading}>Notifications</span>
            {data.unread ? (
              <button type="button" className={styles.linkBtn} onClick={() => void markRead('all')}>
                Mark all read
              </button>
            ) : null}
          </div>
          {data.rows.length ? (
            <ul className={styles.list}>
              {data.rows.map((n) => (
                <Item key={n.id} n={n} onRead={() => void markRead([n.id])} onNavigate={() => setOpen(false)} />
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>Nothing yet. Meeting reminders show up here 15 minutes before.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Item({ n, onRead, onNavigate }: { n: NotificationView; onRead: () => void; onNavigate: () => void }) {
  return (
    <li className={styles.item} data-unread={n.readAt ? undefined : ''}>
      <div className={styles.itemTop}>
        <span className={styles.title}>{n.title}</span>
        <span className={styles.when}>{ago(n.createdAt)}</span>
      </div>
      {n.body ? <div className={styles.body}>{n.body}</div> : null}
      <div className={styles.actions}>
        {n.joinUrl ? (
          <a href={n.joinUrl} target="_blank" rel="noopener noreferrer" className={styles.join} onClick={onRead}>
            Join ↗
          </a>
        ) : null}
        {n.href ? (
          <Link
            href={n.href}
            className={styles.linkBtn}
            onClick={() => {
              onRead();
              onNavigate();
            }}
          >
            Open calendar
          </Link>
        ) : null}
        {!n.readAt ? (
          <button type="button" className={styles.linkBtn} onClick={onRead}>
            Mark read
          </button>
        ) : null}
      </div>
    </li>
  );
}
