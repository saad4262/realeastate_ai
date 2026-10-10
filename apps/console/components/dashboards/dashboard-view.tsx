'use client';

import { useEffect, useRef, useState } from 'react';
import type { DashboardData } from '@repo/core/dashboards';
import { hasReport, Report } from './report';
import { Tile } from './tile';
import styles from './dashboards.module.css';

/**
 * A live dashboard (ADR 0027 §7): asks the server again every 30–60 s with the
 * last version it saw — an unchanged one comes back 304 — and pauses while the
 * tab is hidden. No browser database connection: the server is the only door.
 */
export function DashboardView({ initial, inboxPath }: { initial: DashboardData; inboxPath: string }) {
  const [data, setData] = useState(initial);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const [lost, setLost] = useState<string | null>(null);
  const version = useRef(initial.version);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        try {
          const res = await fetch(`/api/dashboards/${initial.id}/data`, { headers: { 'if-none-match': `"${version.current}"` }, cache: 'no-store' });
          if (res.status === 200) {
            const next = (await res.json()) as DashboardData;
            version.current = next.version;
            setData(next);
            setUpdatedAt(new Date());
          } else if (res.status === 304) {
            setUpdatedAt(new Date());
          } else if (res.status === 404 || res.status === 401 || res.status === 403) {
            setLost('You no longer have access to this dashboard.');
            stopped = true;
            return;
          }
        } catch {
          // Offline for a moment: keep the last figures and try again.
        }
      }
      timer = setTimeout(tick, data.refreshSeconds * 1000);
    };
    timer = setTimeout(tick, data.refreshSeconds * 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [initial.id, data.refreshSeconds]);

  const many = data.tiles.length > 1;
  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <div>
          <div className={styles.eyebrow}>Dashboard</div>
          <h1 className={styles.title}>{data.title}</h1>
          <div className={styles.updated}>Times on the agency’s clock ({data.timeZone}) · every figure is worked out for you, from the agency’s records</div>
        </div>
        <div className={`${styles.live} ${lost ? styles.liveLost : ''}`} role="status" suppressHydrationWarning>
          <span className={styles.liveDot} aria-hidden />
          {lost ?? `Live · updated ${updatedAt.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', second: '2-digit' })} · every ${data.refreshSeconds}s`}
        </div>
      </header>
      {many ? (
        <section className={styles.grid} aria-label="At a glance">
          {data.tiles.map((t, i) => (
            <Tile key={`${t.widget}-${i}`} tile={t} />
          ))}
        </section>
      ) : null}
      {data.tiles.map((t, i) =>
        hasReport(t) ? <Report key={`${t.widget}-${i}`} tile={t} timeZone={data.timeZone} inboxPath={inboxPath} /> : many ? null : <Tile key={`${t.widget}-${i}`} tile={t} />,
      )}
    </main>
  );
}
