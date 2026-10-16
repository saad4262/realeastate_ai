import type { WidgetData, WidgetFormat } from '@repo/core/widgets';
import { BarList, Donut, Empty } from './charts';
import { formatValue } from './format';
import { TrendChart } from './trend-chart';
import styles from './dashboards.module.css';

/**
 * A tile from an open question (ADR 0042): the assistant wrote the query, the
 * database worked out every value, as the person looking at it. This file only
 * lays them out — and says so: "Worked out by the assistant", how, and (for
 * owners and admins) the query itself. Nothing empty is left blank.
 */
type OpenData = Extract<WidgetData, { kind: 'open' }>;
type Cell = OpenData['rows'][number][number];
type Col = OpenData['columns'][number];

const EMPTY = 'No information yet';
const pct = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });

function chartFormat(col: Col | undefined, rows: OpenData['rows'], at: number): WidgetFormat {
  if (col?.format === 'money') return 'money';
  return rows.some((r) => typeof r[at] === 'number' && !Number.isInteger(r[at])) ? 'decimal' : 'count';
}

function show(cell: Cell, col: Col, timeZone: string): string {
  if (cell === null || cell === undefined || cell === '') return EMPTY;
  if (Array.isArray(cell)) return cell.length ? cell.join(', ') : 'None set';
  if (typeof cell === 'boolean') return cell ? 'Yes' : 'No';
  if (typeof cell === 'number') {
    if (col.format === 'money') return formatValue('money', cell);
    if (col.format === 'percent') return `${pct.format(cell)}%`;
    return formatValue(Number.isInteger(cell) ? 'count' : 'decimal', cell);
  }
  if (col.format === 'date' || col.format === 'datetime') {
    const d = new Date(cell);
    if (!Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat('en-AU', { timeZone, dateStyle: 'medium', ...(col.format === 'datetime' ? { timeStyle: 'short' } : {}) }).format(d);
    }
  }
  return cell;
}

function Table({ data, compact }: { data: OpenData; compact: boolean }) {
  const cols = data.columns.map((c, i) => ({ c, i })).filter(({ c }) => !c.hidden);
  const rows = compact ? data.rows.slice(0, 5) : data.rows;
  if (!rows.length) return <Empty>{EMPTY}</Empty>;
  return (
    <div className={styles.tableScroll}>
      <table className={compact ? styles.miniTable : styles.table}>
        <thead>
          <tr>
            {cols.map(({ c }) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, n) => (
            <tr key={n}>
              {cols.map(({ c, i }, j) =>
                j === 0 ? (
                  <th key={c.key} scope="row" data-label={c.label}>
                    {show(r[i] ?? null, c, data.timeZone)}
                  </th>
                ) : (
                  <td key={c.key} data-label={c.label} className={c.format === 'text' || c.format === 'list' ? styles.openText : undefined}>
                    {show(r[i] ?? null, c, data.timeZone)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The first visible column of a kind, and its index in the row. */
function pick(data: OpenData, numeric: boolean): { col: Col; at: number } | null {
  const at = data.columns.findIndex((c) => !c.hidden && (numeric ? ['number', 'money', 'percent', 'decimal'].includes(c.format) : !['number', 'money', 'percent', 'decimal'].includes(c.format)));
  return at < 0 ? null : { col: data.columns[at]!, at };
}

function series(data: OpenData) {
  const label = pick(data, false);
  const value = pick(data, true);
  if (!value) return null;
  return {
    format: chartFormat(value.col, data.rows, value.at),
    rows: data.rows.map((r) => ({ label: label ? show(r[label.at] ?? null, label.col, data.timeZone) : '', value: typeof r[value.at] === 'number' ? (r[value.at] as number) : 0 })),
  };
}

const NUMERIC = ['number', 'money', 'percent', 'decimal'];

/** ADR 0044 F: one row, every visible number as a labelled figure. */
function Figures({ data }: { data: OpenData }) {
  const row = data.rows[0];
  const cols = data.columns.map((c, i) => ({ c, i })).filter(({ c }) => !c.hidden && NUMERIC.includes(c.format));
  if (!row || !cols.length) return <Empty>{EMPTY}</Empty>;
  return (
    <dl className={styles.openFigures}>
      {cols.map(({ c, i }) => {
        const cell = row[i] ?? null;
        return (
          <div key={c.key}>
            <dt>{c.label}</dt>
            <dd data-empty={typeof cell === 'number' ? undefined : ''}>{show(cell, c, data.timeZone)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function Figure({ data, compact }: { data: OpenData; compact: boolean }) {
  switch (data.viz) {
    case 'figures':
      return <Figures data={data} />;
    case 'number': {
      const v = pick(data, true);
      const cell = v ? data.rows[0]?.[v.at] : null;
      return <div className={styles.big}>{v && typeof cell === 'number' ? show(cell, v.col, data.timeZone) : EMPTY}</div>;
    }
    case 'bar':
    case 'donut':
    case 'line': {
      const s = series(data);
      if (!s || !s.rows.length) return <Empty>{EMPTY}</Empty>;
      if (data.viz === 'line') return <TrendChart rows={s.rows} format={s.format} height={compact ? 120 : 230} />;
      if (data.viz === 'donut') {
        const rows = s.rows.length <= 6 ? s.rows : [...s.rows.slice(0, 5), { label: 'Other', value: s.rows.slice(5).reduce((t, r) => t + r.value, 0) }];
        return rows.some((r) => r.value > 0) ? <Donut rows={rows} caption="total" format={s.format} /> : <Empty>{EMPTY}</Empty>;
      }
      return <BarList rows={s.rows} limit={compact ? 4 : 12} format={s.format} />;
    }
    case 'table':
    default:
      return <Table data={data} compact={compact} />;
  }
}

export function OpenFigures({ data, compact }: { data: OpenData; compact: boolean }) {
  if (data.problem) {
    return <p className={styles.muted}>This tile needs rebuilding — ask the assistant to make it again.</p>;
  }
  return (
    <>
      <Figure data={data} compact={compact} />
      {data.missing.length ? (
        <p className={styles.openWarning} role="note">
          Not in this tile: {data.missing.join(', ')}. Ask the assistant to rebuild it so everyone appears.
        </p>
      ) : null}
      {data.truncated ? <p className={styles.muted}>Showing the first {data.rows.length} rows.</p> : null}
      {compact ? null : (
        <div className={styles.openHow}>
          <span className={styles.openBadge}>Worked out by the assistant</span> {data.explanation}
          {data.sql ? (
            <details className={styles.openQuery}>
              <summary>Show query</summary>
              <pre>{data.sql}</pre>
            </details>
          ) : null}
        </div>
      )}
    </>
  );
}
