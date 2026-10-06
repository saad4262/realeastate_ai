import type { WidgetData, WidgetTile } from '@repo/core/widgets';
import styles from './dashboards.module.css';

/**
 * One widget tile (ADR 0027). Every figure on it came from SQL, computed as the
 * person looking at it; this component only draws numbers it is handed.
 */
const money = (n: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(n);
const count = (n: number) => new Intl.NumberFormat('en-AU').format(n);

const NOT_OK = {
  no_access: 'This figure is for owners and admins.',
  unavailable: 'This widget is no longer available.',
  error: 'Could not work this out just now — it will try again.',
} as const;

function Figures({ data, compact }: { data: WidgetData; compact: boolean }) {
  switch (data.kind) {
    case 'money':
      return (
        <>
          <div className={styles.big}>{money(data.total)}</div>
          <div className={styles.sub}>
            {count(data.count)} sale{data.count === 1 ? '' : 's'} with a price
            {data.undisclosed ? ` · ${count(data.undisclosed)} sold with no disclosed price (not counted as $0)` : ''}
          </div>
        </>
      );
    case 'count':
      return <div className={styles.big}>{count(data.total)}</div>;
    case 'status':
      return (
        <>
          <div className={styles.big}>{count(data.active)}</div>
          <div className={styles.sub}>{data.rows.map((r) => `${count(r.value)} ${r.label.toLowerCase()}`).join(' · ')}</div>
        </>
      );
    case 'breakdown':
      return (
        <>
          <div className={styles.big}>{count(data.total)}</div>
          {data.rows.length ? (
            <ul className={styles.rows}>
              {data.rows.slice(0, compact ? 4 : 10).map((r) => (
                <li key={r.label}>
                  <span>{r.label}</span>
                  <span>{count(r.value)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      );
  }
}

export function Tile({ tile, compact = false }: { tile: WidgetTile; compact?: boolean }) {
  return (
    <div className={`${styles.tile} ${compact ? styles.compact : ''}`} data-state={tile.state}>
      <div className={styles.tileTitle}>{tile.description}</div>
      {tile.state === 'ok' ? <Figures data={tile.data} compact={compact} /> : <p className={styles.muted}>{NOT_OK[tile.state]}</p>}
    </div>
  );
}
