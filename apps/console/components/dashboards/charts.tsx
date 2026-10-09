import type { WidgetFormat } from '@repo/core/widgets';
import { formatShort, formatValue } from './format';
import styles from './dashboards.module.css';

/**
 * The drawing layer for dashboard tiles and reports (ADR 0027). Plain SVG/HTML,
 * no chart library: these only draw numbers they are handed — every figure
 * came from SQL on the server. Server-renderable, so a tile never flashes empty.
 */
type Row = { label: string; value: number };

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** Fixed hue order, never cycled (a ring has at most six slices; core folds the rest into "Other"). */
export const SERIES = ['var(--sapphire)', 'var(--emerald)', 'var(--amber)', 'var(--rose)', '#7c3aed', '#64748b'];

/** A "nice" axis ceiling so gridlines land on round numbers. */
export function niceMax(max: number, steps = 4): number {
  if (max <= steps) return Math.max(steps, Math.ceil(max));
  const raw = max / steps;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
  return step * steps;
}

export function Empty({ children = 'Nothing in this period yet.' }: { children?: string }) {
  return <p className={styles.empty}>{children}</p>;
}

/** Horizontal bars — for "by agent", "by type", "by suburb". Names stay readable; the value sits at the bar's end. */
export function BarList({ rows, total, limit, format = 'count' }: { rows: Row[]; total?: number; limit: number; format?: WidgetFormat }) {
  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit).reduce((s, r) => s + r.value, 0);
  const list = rest ? [...shown, { label: `${rows.length - limit} more`, value: rest }] : shown;
  const whole = total ?? rows.reduce((s, r) => s + r.value, 0);
  const max = Math.max(1, ...list.map((r) => r.value));
  if (!rows.some((r) => r.value > 0)) return <Empty />;
  return (
    <ul className={styles.bars}>
      {list.map((r, i) => (
        <li key={r.label} className={styles.barRow} title={`${r.label}: ${formatValue(format, r.value)} (${pct(r.value, whole)}%)`}>
          <span className={styles.barLabel}>{r.label}</span>
          <span className={styles.barTrack}>
            <span
              className={styles.barFill}
              style={{ width: `${r.value > 0 ? Math.max(2, (r.value / max) * 100) : 0}%`, background: i < shown.length ? SERIES[0] : 'var(--border-strong)' }}
            />
          </span>
          <span className={styles.barValue}>{formatShort(format, r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Columns — for "per day" on a tile, price bands and days of the week in a report. Quiet gridlines; labels thinned to fit. */
export function Columns({
  rows,
  height = 150,
  format = 'count',
  shortLabel = (l) => l,
  emphasiseLast = false,
}: {
  rows: Row[];
  height?: number;
  format?: WidgetFormat;
  shortLabel?: (label: string) => string;
  emphasiseLast?: boolean;
}) {
  if (!rows.some((r) => r.value > 0)) return <Empty />;
  const W = 340;
  const top = 14;
  const bottom = 22;
  const left = 30;
  const plotH = height - top - bottom;
  const max = niceMax(Math.max(1, ...rows.map((r) => r.value)), 2);
  const slot = (W - left) / Math.max(rows.length, 1);
  const barW = Math.max(4, Math.min(30, slot * 0.62));
  const every = Math.ceil(rows.length / 7);
  const y = (v: number) => top + plotH - (v / max) * plotH;
  return (
    <svg className={styles.svg} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={rows.map((r) => `${r.label} ${formatValue(format, r.value)}`).join(', ')}>
      {[0, max / 2, max].map((t) => (
        <g key={t}>
          <line x1={left} x2={W} y1={y(t)} y2={y(t)} className={t === 0 ? styles.axis : styles.grid2} />
          <text x={left - 6} y={y(t) + 3} textAnchor="end" className={styles.tick}>
            {formatShort(format, t)}
          </text>
        </g>
      ))}
      {rows.map((r, i) => {
        const x = left + i * slot + (slot - barW) / 2;
        const h = r.value > 0 ? Math.max(2, (r.value / max) * plotH) : 0;
        const strong = !emphasiseLast || i === rows.length - 1;
        const showValue = rows.length <= 8 && r.value > 0;
        return (
          <g key={`${r.label}-${i}`} className={styles.col}>
            <title>{`${r.label}: ${formatValue(format, r.value)}`}</title>
            <rect x={left + i * slot} y={top} width={slot} height={plotH + bottom} fill="transparent" />
            <rect x={x} y={top + plotH - h} width={barW} height={h} rx={Math.min(4, barW / 2)} fill={SERIES[0]} opacity={strong ? 1 : 0.5} />
            {showValue ? (
              <text x={x + barW / 2} y={top + plotH - h - 4} textAnchor="middle" className={styles.colValue}>
                {formatShort(format, r.value)}
              </text>
            ) : null}
            {i % every === 0 ? (
              <text x={x + barW / 2} y={height - 6} textAnchor="middle" className={styles.tick}>
                {shortLabel(r.label)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Ring with the headline in the middle — for a split of one whole. */
export function Donut({ rows, centre, caption, format = 'count' }: { rows: Row[]; centre?: number; caption: string; format?: WidgetFormat }) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  const R = 42;
  const C = 2 * Math.PI * R;
  const GAP = rows.filter((r) => r.value > 0).length > 1 ? 3 : 0;
  let offset = 0;
  return (
    <div className={styles.donutWrap}>
      <svg className={styles.donut} viewBox="0 0 110 110" role="img" aria-label={`${caption}: ${rows.map((r) => `${formatValue(format, r.value)} ${r.label}`).join(', ')}`}>
        <circle cx="55" cy="55" r={R} fill="none" stroke="var(--surface-container-low)" strokeWidth="13" />
        {total > 0
          ? rows.map((r, i) => {
              const len = (r.value / total) * C;
              const seg = Math.max(0, len - GAP);
              const el = (
                <circle
                  key={r.label}
                  cx="55"
                  cy="55"
                  r={R}
                  fill="none"
                  stroke={SERIES[i % SERIES.length]}
                  strokeWidth="13"
                  strokeDasharray={`${seg} ${C - seg}`}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 55 55)"
                  className={styles.slice}
                >
                  <title>{`${r.label}: ${formatValue(format, r.value)} (${pct(r.value, total)}%)`}</title>
                </circle>
              );
              offset += len;
              return el;
            })
          : null}
        <text x="55" y="54" textAnchor="middle" className={styles.donutNum}>
          {formatShort(format, centre ?? total)}
        </text>
        <text x="55" y="69" textAnchor="middle" className={styles.tick}>
          {caption}
        </text>
      </svg>
      <ul className={styles.legend}>
        {rows.map((r, i) => (
          <li key={r.label}>
            <span className={styles.swatch} style={{ background: SERIES[i % SERIES.length] }} aria-hidden />
            <span className={styles.legendLabel}>{r.label}</span>
            <span className={styles.legendValue}>
              {formatShort(format, r.value)} <span className={styles.muted2}>· {pct(r.value, total)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One thin stacked bar — "sales with a price" against "sold with no disclosed price". */
export function SplitBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return null;
  return (
    <div className={styles.split}>
      <div className={styles.splitBar} role="img" aria-label={parts.map((p) => `${p.value} ${p.label}`).join(', ')}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span key={p.label} style={{ flexGrow: p.value, background: p.color }} title={`${p.label}: ${formatValue('count', p.value)}`} />
          ))}
      </div>
      <ul className={styles.legend}>
        {parts.map((p) => (
          <li key={p.label}>
            <span className={styles.swatch} style={{ background: p.color }} aria-hidden />
            <span className={styles.legendLabel}>{p.label}</span>
            <span className={styles.legendValue}>{formatValue('count', p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
