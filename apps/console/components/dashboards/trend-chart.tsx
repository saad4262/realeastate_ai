'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { WidgetFormat } from '@repo/core/widgets';
import { Empty, niceMax } from './charts';
import { formatShort, formatValue } from './format';
import styles from './dashboards.module.css';

/**
 * A figure over time: one line with a soft area under it, quiet gridlines, and
 * a crosshair + tooltip that follows the pointer (or the arrow keys). Draws
 * only the numbers it is handed; every step of the window is present, so a
 * quiet day is a visible 0 rather than a gap.
 */
export function TrendChart({ rows, format, height = 230 }: { rows: { label: string; value: number }[]; format: WidgetFormat; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Drawn at the width it is shown at, so labels stay a readable size on a phone and on a TV.
  const [W, setW] = useState(720);
  const gradient = useId().replace(/:/g, '');
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!rows.some((r) => r.value > 0)) return <Empty />;

  const top = 16;
  const bottom = 26;
  const left = format === 'money' ? 58 : 36;
  const right = 12;
  const plotW = W - left - right;
  const plotH = height - top - bottom;
  const max = niceMax(Math.max(...rows.map((r) => r.value)));
  const x = (i: number) => left + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const pts = rows.map((r, i) => [x(i), y(r.value)] as const);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = `${line} L${pts.at(-1)![0].toFixed(1)},${top + plotH} L${pts[0]![0].toFixed(1)},${top + plotH} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const every = Math.max(1, Math.ceil(rows.length / Math.max(3, Math.floor(plotW / 80))));
  const shortLabel = (l: string) => l.replace(/^\w{3} /, '');

  const pick = (clientX: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const sx = ((clientX - box.left) / box.width) * W;
    const i = rows.length === 1 ? 0 : Math.round(((sx - left) / plotW) * (rows.length - 1));
    setHover(Math.min(rows.length - 1, Math.max(0, i)));
  };
  const h = hover === null ? null : { i: hover, row: rows[hover]!, px: pts[hover]![0], py: pts[hover]![1] };

  return (
    <div className={styles.trend} ref={boxRef}>
      <svg
        ref={svgRef}
        className={styles.svg}
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        tabIndex={0}
        aria-label={rows.map((r) => `${r.label} ${formatValue(format, r.value)}`).join(', ')}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setHover((v) => Math.min(rows.length - 1, (v ?? -1) + 1));
          if (e.key === 'ArrowLeft') setHover((v) => Math.max(0, (v ?? rows.length) - 1));
        }}
      >
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1, var(--sapphire))" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--chart-1, var(--sapphire))" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} className={t === 0 ? styles.axis : styles.grid2} />
            <text x={left - 8} y={y(t) + 3} textAnchor="end" className={styles.tick}>
              {formatShort(format, t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          i % every === 0 || i === rows.length - 1 ? (
            <text key={`${r.label}-${i}`} x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'} className={styles.tick}>
              {shortLabel(r.label)}
            </text>
          ) : null,
        )}
        <path d={area} fill={`url(#${gradient})`} />
        <path d={line} fill="none" stroke="var(--chart-1, var(--sapphire))" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {rows.length <= 14
          ? pts.map(([px, py], i) => <circle key={i} cx={px} cy={py} r="2.5" fill="var(--surface-card)" stroke="var(--chart-1, var(--sapphire))" strokeWidth="1.5" />)
          : null}
        {h ? (
          <g pointerEvents="none">
            <line x1={h.px} x2={h.px} y1={top} y2={top + plotH} className={styles.crosshair} />
            <circle cx={h.px} cy={h.py} r="5" fill="var(--chart-1, var(--sapphire))" stroke="var(--surface-card)" strokeWidth="2" />
          </g>
        ) : null}
      </svg>
      {h ? (
        <div
          className={styles.tooltip}
          style={{ left: `${(h.px / W) * 100}%`, top: `${(h.py / height) * 100}%`, transform: `translate(${h.px > W * 0.75 ? '-105%' : '8%'}, -120%)` }}
        >
          <div className={styles.tooltipLabel}>{h.row.label}</div>
          <div className={styles.tooltipValue}>{formatValue(format, h.row.value)}</div>
        </div>
      ) : null}
    </div>
  );
}
