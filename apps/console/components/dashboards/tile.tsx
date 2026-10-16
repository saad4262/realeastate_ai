import type { WidgetData, WidgetTile } from '@repo/core/widgets';
import { AgentsFigures } from './agents';
import { CustomFigures } from './custom';
import { OpenFigures } from './open';
import { BarList, Columns, Donut, SplitBar } from './charts';
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
  too_slow: 'Taking too long — try a shorter range.',
} as const;

function Figures({ widget, data, compact }: { widget: string; data: WidgetData; compact: boolean }) {
  switch (data.kind) {
    case 'money':
      return (
        <>
          <div className={styles.big}>{money(data.total)}</div>
          <div className={styles.sub}>
            {count(data.count)} sale{data.count === 1 ? '' : 's'} with a price
          </div>
          {data.undisclosed ? (
            <SplitBar
              parts={[
                { label: 'With a price', value: data.count, color: 'var(--chart-1, var(--sapphire))' },
                { label: 'No disclosed price (not counted as $0)', value: data.undisclosed, color: 'var(--border-strong)' },
              ]}
            />
          ) : null}
        </>
      );
    case 'count':
      return <div className={styles.big}>{count(data.total)}</div>;
    case 'status':
      return <Donut rows={data.rows} centre={data.active} caption="active" />;
    case 'agents':
      return <AgentsFigures data={data} compact={compact} />;
    case 'custom':
      return <CustomFigures data={data} compact={compact} />;
    case 'open':
      return <OpenFigures data={data} compact={compact} />;
    case 'breakdown': {
      const empty = data.rows.length === 0;
      return (
        <>
          <div className={styles.big}>{count(data.total)}</div>
          {empty ? (
            <p className={styles.muted}>Nothing in this period yet.</p>
          ) : widget === 'new_leads' && data.rows.length > 1 && !compact ? (
            <Columns rows={data.rows} shortLabel={(l) => l.replace(/^\w{3} /, '')} emphasiseLast />
          ) : (
            <BarList rows={data.rows} total={data.total} limit={compact ? 4 : 8} />
          )}
        </>
      );
    }
  }
}

/**
 * A tile whose figures are a table or a row of several headline figures needs the room: on the
 * dashboard's grid it takes the whole row (`data-wide`) instead of being squeezed into one column.
 */
function isWide(tile: WidgetTile): boolean {
  if (tile.state !== 'ok') return false;
  const d = tile.data;
  if (d.kind === 'open') return d.viz === 'table' || d.viz === 'figures' || d.viz === 'line';
  if (d.kind === 'custom') return d.viz === 'table' || d.viz === 'line';
  return d.kind === 'agents';
}

export function Tile({ tile, compact = false }: { tile: WidgetTile; compact?: boolean }) {
  return (
    <div className={`${styles.tile} ${compact ? styles.compact : ''}`} data-state={tile.state} data-wide={!compact && isWide(tile) ? '' : undefined}>
      <div className={styles.tileTitle}>{tile.description}</div>
      {tile.state === 'ok' ? <Figures widget={tile.widget} data={tile.data} compact={compact} /> : <p className={styles.muted}>{NOT_OK[tile.state]}</p>}
    </div>
  );
}
