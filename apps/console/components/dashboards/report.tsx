import type { WidgetDetail, WidgetFormat, WidgetTile } from '@repo/core/widgets';
import { BarList, Columns, Donut } from './charts';
import { formatValue } from './format';
import { TrendChart } from './trend-chart';
import styles from './dashboards.module.css';

/**
 * One widget as a full report (ADR 0027): the headline with its change from
 * the period before, a row of figures, the trend, and four breakdowns — so
 * a dashboard of a single widget still reads as a designed page. Every number
 * here came from SQL as the viewer; this file only lays them out.
 */
type OkTile = Extract<WidgetTile, { state: 'ok' }>;

function headline(tile: OkTile): { value: number; format: WidgetFormat } {
  const d = tile.data;
  switch (d.kind) {
    case 'money':
      return { value: d.total, format: 'money' };
    case 'status':
      return { value: d.active, format: 'count' };
    default:
      return { value: d.total, format: 'count' };
  }
}

/** The change against the comparison window, said with an arrow and words, never colour alone. */
function Delta({ now, before, label }: { now: number; before: number; label: string }) {
  if (now === before) return <span className={`${styles.delta} ${styles.flat}`}>No change {label}</span>;
  const up = now > before;
  const text = before === 0 ? 'from 0' : `${Math.abs(Math.round(((now - before) / before) * 100))}%`;
  return (
    <span className={`${styles.delta} ${up ? styles.up : styles.down}`}>
      <span aria-hidden>{up ? '▲' : '▼'}</span> {up ? 'up ' : 'down '}
      {text} <span className={styles.deltaLabel}>{label}</span>
    </span>
  );
}

function Card({ title, children, wide = false }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`${styles.card} ${wide ? styles.cardWide : ''}`}>
      <h3 className={styles.cardTitle}>{title}</h3>
      {children}
    </div>
  );
}

function Breakdown({ b }: { b: WidgetDetail['breakdowns'][number] }) {
  if (b.chart === 'donut') {
    return b.rows.some((r) => r.value > 0) ? <Donut rows={b.rows} caption="total" format={b.format} /> : <p className={styles.empty}>Nothing in this period yet.</p>;
  }
  if (b.chart === 'columns') return <Columns rows={b.rows} format={b.format} />;
  return <BarList rows={b.rows} limit={7} format={b.format} />;
}

export function Report({ tile }: { tile: OkTile & { detail: WidgetDetail } }) {
  const { detail } = tile;
  const head = headline(tile);
  const donut = detail.breakdowns.find((b) => b.chart === 'donut');
  const rest = detail.breakdowns.filter((b) => b !== donut);
  return (
    <section className={styles.report} aria-label={tile.description}>
      <h2 className={styles.reportTitle}>{tile.description}</h2>
      <div className={styles.kpis}>
        <div className={`${styles.kpi} ${styles.kpiHero}`}>
          <div className={styles.kpiLabel}>{tile.title}</div>
          <div className={styles.kpiHeroValue}>{formatValue(head.format, head.value)}</div>
          {detail.compare ? <Delta now={head.value} before={detail.compare.previous} label={detail.compare.label} /> : null}
          {detail.compare ? <div className={styles.kpiFoot}>Before: {formatValue(head.format, detail.compare.previous)}</div> : null}
        </div>
        {detail.kpis.map((k) => (
          <div key={k.label} className={styles.kpi}>
            <div className={styles.kpiLabel}>{k.label}</div>
            <div className={styles.kpiValue}>{formatValue(k.format, k.value)}</div>
          </div>
        ))}
      </div>
      <div className={styles.row2}>
        <Card title={detail.trend.title} wide>
          <TrendChart rows={detail.trend.rows} format={detail.trend.format} />
        </Card>
        {donut ? (
          <Card title={donut.title}>
            <Breakdown b={donut} />
          </Card>
        ) : null}
      </div>
      <div className={styles.row3}>
        {rest.map((b) => (
          <Card key={b.title} title={b.title}>
            <Breakdown b={b} />
          </Card>
        ))}
      </div>
    </section>
  );
}

export function hasReport(tile: WidgetTile): tile is OkTile & { detail: WidgetDetail } {
  return tile.state === 'ok' && !!tile.detail;
}
