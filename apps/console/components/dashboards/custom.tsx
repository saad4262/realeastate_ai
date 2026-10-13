import type { WidgetData } from '@repo/core/widgets';
import { BarList, Columns, Donut, Empty } from './charts';
import { formatValue } from './format';
import { TrendChart } from './trend-chart';
import styles from './dashboards.module.css';

/**
 * A tile made of a spec (ADR 0036): one figure, bars, a line, columns, a ring
 * or a table — chosen by the spec, drawn here. Every number came from SQL as
 * the viewer; this file only lays them out.
 */
type CustomData = Extract<WidgetData, { kind: 'custom' }>;

const valueOf = (v: number | null) => v ?? 0;

/** A ring has at most six slices: the rest fold into "Other". */
function fold(rows: { label: string; value: number }[]) {
  if (rows.length <= 6) return rows;
  return [...rows.slice(0, 5), { label: 'Other', value: rows.slice(5).reduce((s, r) => s + r.value, 0) }];
}

/** The first measure by the first dimension, as chart rows. */
function series(data: CustomData) {
  return data.rows.map((r) => ({ label: r.labels.join(' · '), value: valueOf(r.values[0] ?? null) }));
}

function Notes({ data }: { data: CustomData }) {
  const shown = data.notes.filter((n) => n.value > 0);
  if (!shown.length) return null;
  return (
    <ul className={styles.notes}>
      {shown.map((n) => (
        <li key={n.label}>
          {n.label}: <strong>{formatValue('count', n.value)}</strong>
        </li>
      ))}
    </ul>
  );
}

function Table({ data, compact }: { data: CustomData; compact: boolean }) {
  const rows = compact ? data.rows.slice(0, 5) : data.rows;
  if (!rows.length) return <Empty />;
  return (
    <div className={styles.tableScroll}>
      <table className={compact ? styles.miniTable : styles.table}>
        <thead>
          <tr>
            {data.dimensions.map((d) => (
              <th key={d.id} scope="col">
                {d.label}
              </th>
            ))}
            {data.measures.map((m) => (
              <th key={m.id} scope="col">
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.labels.join('|')}-${i}`}>
              {r.labels.map((l, j) => (
                <th key={j} scope="row">
                  {l}
                </th>
              ))}
              {data.measures.map((m, j) => (
                <td key={m.id}>{formatValue(m.format, r.values[j] ?? null)}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {data.dimensions.length ? (
          <tfoot>
            <tr>
              <th scope="row" colSpan={data.dimensions.length}>
                All
              </th>
              {data.measures.map((m, j) => (
                <td key={m.id}>{formatValue(m.format, data.total[j] ?? null)}</td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

export function CustomFigures({ data, compact }: { data: CustomData; compact: boolean }) {
  const first = data.measures[0]!;
  const headline = (
    <>
      <div className={styles.big}>{formatValue(first.format, data.total[0] ?? null)}</div>
      {data.measures.length > 1 && data.viz !== 'table' ? (
        <div className={styles.sub}>
          {data.measures
            .slice(1)
            .map((m, i) => `${m.label}: ${formatValue(m.format, data.total[i + 1] ?? null)}`)
            .join(' · ')}
        </div>
      ) : null}
    </>
  );
  const more = data.groups > data.rows.length ? <p className={styles.muted}>Showing {data.rows.length} of {data.groups}</p> : null;

  switch (data.viz) {
    case 'number':
      return (
        <>
          {headline}
          <Notes data={data} />
        </>
      );
    case 'table':
      return (
        <>
          <Table data={data} compact={compact} />
          <Notes data={data} />
          {more}
        </>
      );
    case 'line':
      return (
        <>
          {headline}
          {data.rows.length ? <TrendChart rows={series(data)} format={first.format} height={compact ? 120 : 230} /> : <Empty />}
          <Notes data={data} />
        </>
      );
    case 'columns':
      return (
        <>
          {headline}
          <Columns rows={series(data)} format={first.format} />
          <Notes data={data} />
        </>
      );
    case 'donut':
      return (
        <>
          {series(data).some((r) => r.value > 0) ? <Donut rows={fold(series(data))} caption="total" format={first.format} /> : <Empty />}
          <Notes data={data} />
          {more}
        </>
      );
    case 'bar':
    default:
      return (
        <>
          {headline}
          <BarList rows={series(data)} limit={compact ? 4 : 12} format={first.format} />
          <Notes data={data} />
          {more}
        </>
      );
  }
}
