import Link from 'next/link';
import { AI_COST_PERIODS, capState, type AiCostFeature, type AiCostPeriod } from '@repo/core/platform';
import styles from './admin.module.css';

/** The pieces of the admin's AI cost page (ADR 0086). Server only: the figures all come from packages/core. */

export const usd = (n: number) => `$${n.toFixed(2)}`;
const count = (n: number) => n.toLocaleString('en-AU');
const pct = (n: number) => `${Math.round(n * 100)}%`;

function perCall(spend: number, calls: number): string {
  if (!calls) return '—';
  const each = spend / calls;
  return each < 0.001 ? 'Under $0.001' : `$${each.toFixed(3)}`;
}

const PERIOD_LABEL: Record<AiCostPeriod, string> = { 1: '24 hours', 7: '7 days', 30: '30 days' };
export const periodWords = (p: AiCostPeriod) => `Last ${PERIOD_LABEL[p]}`;

export function PeriodTabs({ base, period }: { base: string; period: AiCostPeriod }) {
  return (
    <nav className={styles.tabs} aria-label="Period">
      {AI_COST_PERIODS.map((p) => (
        <Link key={p} href={`${base}?days=${p}`} className={p === period ? styles.tabOn : styles.tab}>
          {PERIOD_LABEL[p]}
        </Link>
      ))}
    </nav>
  );
}

export function TextStat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

/** Green, amber or red by how close to the limit, and the same words wherever a limit is shown. */
export function CapBadge({ spent, cap }: { spent: number; cap: number }) {
  const state = capState(spent, cap);
  if (state === 'over') return <span className={styles.badgeBad}>At the limit</span>;
  return <span className={state === 'near' ? styles.badgeWarn : styles.badgeGood}>{cap > 0 ? pct(spent / cap) : '—'}</span>;
}

export function LimitCard({ spent, cap, of, children }: { spent: number; cap: number; of: string; children: React.ReactNode }) {
  const state = capState(spent, cap);
  const width = cap > 0 ? Math.min(100, (spent / cap) * 100) : 100;
  return (
    <section className={styles.card}>
      <div className={styles.cardBody}>
        <div className={styles.limitTop}>
          <p className={styles.limitNum}>
            {usd(spent)} <small>of {usd(cap)} {of}</small>
          </p>
          <CapBadge spent={spent} cap={cap} />
        </div>
        <div className={styles.meter} role="img" aria-label={`${usd(spent)} of ${usd(cap)}`}>
          <span className={state === 'over' ? styles.meterOver : state === 'near' ? styles.meterNear : styles.meterOk} style={{ width: `${width}%` }} />
        </div>
        <p className={styles.fine}>{children}</p>
      </div>
    </section>
  );
}

export function ShareBar({ part, whole }: { part: number; whole: number }) {
  const share = whole > 0 ? part / whole : 0;
  return (
    <span className={styles.share}>
      <span className={styles.barTrack} aria-hidden>
        <span className={styles.barFill} style={{ display: 'block', width: `${share * 100}%` }} />
      </span>
      <span>{pct(share)}</span>
    </span>
  );
}

const DAY = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayWords = (key: string) => DAY.format(new Date(`${key}T00:00:00Z`));

/**
 * Spend per Sydney day against the limit. One measure, one hue; a day past 80% of the limit turns red, and a
 * visually hidden table carries every figure for a screen reader. The limit is 24 rolling hours and these are
 * calendar days, so a day's bar only roughly lines up with it.
 */
export function SpendChart({ days, cap }: { days: { day: string; spend: number }[]; cap: number }) {
  const top = Math.max(cap * 1.2, ...days.map((d) => d.spend), 1);
  const at = (v: number) => `${(v / top) * 100}%`;
  return (
    <figure className={styles.spend}>
      <div className={styles.spendPlot} aria-hidden>
        {[cap / 2, cap].map((v) => (
          <span key={v} className={v === cap ? styles.spendCap : styles.spendGrid} style={{ bottom: at(v) }}>
            <span className={styles.spendTick}>{usd(v)}</span>
            {v === cap ? <span className={styles.spendCapLabel}>Limit</span> : null}
          </span>
        ))}
        {days.map((d, i) => (
          <div
            key={d.day}
            title={`${i === days.length - 1 ? 'Today so far' : dayWords(d.day)}: ${usd(d.spend)}`}
            className={capState(d.spend, cap) === 'ok' ? styles.spendBar : styles.spendBarHot}
            style={{ height: at(d.spend) }}
          />
        ))}
      </div>
      <div className={styles.spendAxis} aria-hidden>
        <span>{days[0] ? dayWords(days[0].day) : ''}</span>
        <span>Today so far</span>
      </div>
      <table className={styles.srOnly}>
        <caption>Spend per day, last 30 days</caption>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{dayWords(d.day)}</th>
              <td>{usd(d.spend)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function FeatureTable({ features, spend, calls }: { features: AiCostFeature[]; spend: number; calls: number }) {
  if (!features.length) return <p className={styles.empty}>No AI calls in this period.</p>;
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Feature</th>
            <th className={styles.num}>Spend</th>
            <th>Share</th>
            <th className={styles.num}>Calls</th>
            <th className={styles.num}>Per call</th>
            <th>Runs on</th>
          </tr>
        </thead>
        <tbody>
          {features.map((f) => (
            <tr key={f.label}>
              <td>
                {f.label}
                <small className={styles.cellNote}>{f.features.join(', ')}</small>
              </td>
              <td className={styles.num} data-label="Spend">{usd(f.spend)}</td>
              <td data-label="Share"><ShareBar part={f.spend} whole={spend} /></td>
              <td className={styles.num} data-label="Calls">{count(f.calls)}</td>
              <td className={styles.num} data-label="Per call">{perCall(f.spend, f.calls)}</td>
              <td data-label="Runs on">{f.model}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>Total</strong></td>
            <td className={styles.num} data-label="Spend"><strong>{usd(spend)}</strong></td>
            <td />
            <td className={styles.num} data-label="Calls"><strong>{count(calls)}</strong></td>
            <td />
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export { count, perCall, pct };
