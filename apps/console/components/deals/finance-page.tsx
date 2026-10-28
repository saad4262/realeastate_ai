import Link from 'next/link';
import { DealError, FINANCE_PERIODS, financeReport, groupFinance, type FinanceDeal, type FinancePeriod } from '@repo/core/deals';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { loadListingActor } from '../../lib/load-actor';
import { requireConsoleAccess } from '../../lib/require-console-access';
import styles from './deals.module.css';

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const money = (n: number | null) => (n === null ? '—' : AUD.format(n));
const DAY = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const day = (iso: string | null) => (iso ? DAY.format(new Date(`${iso}T00:00:00Z`)) : '—');
const PERIOD_LABELS: Record<FinancePeriod, string> = { month: 'This month', quarter: 'This quarter', fy: 'This financial year', last_fy: 'Last financial year' };
const BYS = ['agent', 'suburb', 'type', 'deals'] as const;
type By = (typeof BYS)[number];
const BY_LABELS: Record<By, string> = { agent: 'Agent', suburb: 'Suburb', type: 'Property type', deals: 'Each deal' };

export function financeParams(sp: { period?: string; by?: string }): { period: FinancePeriod; by: By } {
  return {
    period: (FINANCE_PERIODS as readonly string[]).includes(sp.period ?? '') ? (sp.period as FinancePeriod) : 'fy',
    by: (BYS as readonly string[]).includes(sp.by ?? '') ? (sp.by as By) : 'agent',
  };
}

/**
 * The Finance page (ADR 0064): commission earned on settled sales, expected from deals under contract, the
 * agency's and the agents' shares, and what has been paid out — owners and admins for the agency, anyone
 * else for their own deals. Every figure is core's, from the one commission expression.
 */
export async function FinancePage({ surface, period, by }: { surface: 'agency' | 'agent'; period: FinancePeriod; by: By }) {
  const session = await requireConsoleAccess(surface);
  const actor = (await loadListingActor(session.actor.userId)) ?? session.actor;
  const base = surface === 'agency' ? '/finance' : '/my-commission';
  const listingBase = surface === 'agency' ? '/live-listings' : '/listings';
  let r;
  try {
    r = await financeReport(getConsoleDb(), actor, { period });
  } catch (err) {
    return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{err instanceof DealError ? err.message : 'Could not load Finance'}</p>;
  }
  const agency = r.scope === 'agency';
  const href = (p: FinancePeriod, b: By) => `${base}?period=${p}${b === 'agent' ? '' : `&by=${b}`}`;
  const tiles = agency
    ? [
        { label: 'Earned', value: r.tiles.earned, foot: `${r.tiles.earnedCount} sale${r.tiles.earnedCount === 1 ? '' : 's'} settled · excl. GST` },
        { label: 'Expected', value: r.tiles.expected, foot: `${r.tiles.expectedCount} deal${r.tiles.expectedCount === 1 ? '' : 's'} under contract` },
        { label: 'Agency’s share earned', value: r.tiles.agencyEarned, foot: 'after agents’ splits' },
        { label: 'Paid out to agents', value: r.tiles.paidOut, foot: 'agents’ shares marked paid in the period' },
      ]
    : [
        { label: 'Your share earned', value: r.tiles.agentEarned, foot: `${r.tiles.earnedCount} of your sales settled` },
        { label: 'Your share expected', value: r.tiles.agentExpected, foot: `${r.tiles.expectedCount} of your deals under contract` },
        { label: 'Paid to you', value: r.tiles.paidOut, foot: 'marked paid by the agency in the period' },
        { label: 'Commission earned', value: r.tiles.earned, foot: 'the whole commission on your settled sales' },
      ];
  const groups = by === 'deals' ? null : groupFinance(r.deals, by);
  const dealStatus = (d: FinanceDeal) => (d.paidOn ? 'Paid out' : d.earnedInPeriod ? 'Earned' : d.expected ? 'Expected' : 'Earned earlier');

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>{agency ? 'Finance' : 'My commission'}</h1>
          <p className={contactStyles.sub}>
            {agency ? 'Commission across the agency' : 'Your commission'}: earned on settled sales and expected from deals under contract · {r.period.label} ({day(r.period.from)} – {day(r.period.to)}).
          </p>
        </div>
        <nav className={styles.filters} aria-label="Period">
          {FINANCE_PERIODS.map((p) => (
            <Link key={p} href={href(p, by)} className={`${styles.chip} ${p === period ? styles.chipOn : ''}`} aria-current={p === period ? 'page' : undefined}>{PERIOD_LABELS[p]}</Link>
          ))}
        </nav>
      </div>

      <div className={styles.stats}>
        {tiles.map((t) => (
          <div key={t.label} className={styles.stat}>
            <span>{t.label}</span>
            <b>{money(t.value)}</b>
            <span>{t.foot}</span>
          </div>
        ))}
      </div>

      {agency && r.missingCommission ? (
        <p className={styles.note}>
          <span className={styles.glyph} aria-hidden>error</span>
          <span>{r.missingCommission} deal{r.missingCommission === 1 ? '' : 's'} under contract or settled {r.missingCommission === 1 ? 'has' : 'have'} no commission set and {r.missingCommission === 1 ? 'is' : 'are'} not in these figures. Set it on each deal’s Deal tab (“Each deal” lists them).</span>
        </p>
      ) : null}

      <section className={styles.panel} aria-labelledby="fin-table" style={{ padding: 0, overflow: 'hidden' }}>
        <div className={styles.panelHead} style={{ padding: '0.75rem 0.875rem', margin: 0, borderBottom: '1px solid var(--border-default)' }}>
          <h3 id="fin-table">{by === 'deals' ? 'Each deal' : `By ${BY_LABELS[by].toLowerCase()}`}</h3>
          <nav className={styles.filters} aria-label="Group by">
            {BYS.filter((b) => agency || b !== 'agent').map((b) => (
              <Link key={b} href={href(period, b)} className={`${styles.chip} ${b === by ? styles.chipOn : ''}`} aria-current={b === by ? 'page' : undefined}>{BY_LABELS[b]}</Link>
            ))}
          </nav>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {groups ? (
            <table className={styles.finTable}>
              <thead>
                <tr><th>{BY_LABELS[by]}</th><th className={styles.num}>Settled</th><th className={styles.num}>Earned</th><th className={styles.num}>Agent share</th><th className={styles.num}>Agency share</th><th className={styles.num}>Expected</th></tr>
              </thead>
              <tbody>
                {groups.length === 0 ? <tr><td colSpan={6} className={styles.muted}>Nothing settled or under contract in this period.</td></tr> : null}
                {groups.map((g) => (
                  <tr key={g.key}><td>{g.label}</td><td className={styles.num}>{g.settled}</td><td className={styles.num}>{money(g.earned)}</td><td className={styles.num}>{money(g.agentShare)}</td><td className={styles.num}>{money(g.agencyShare)}</td><td className={styles.num}>{money(g.expected)}</td></tr>
                ))}
              </tbody>
              {groups.length > 1 ? (
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td className={styles.num}>{r.tiles.earnedCount}</td>
                    <td className={styles.num}>{money(r.tiles.earned)}</td>
                    <td className={styles.num}>{money(r.tiles.agentEarned)}</td>
                    <td className={styles.num}>{money(r.tiles.agencyEarned)}</td>
                    <td className={styles.num}>{money(r.tiles.expected)}</td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          ) : (
            <table className={styles.finTable}>
              <thead>
                <tr><th>Deal</th><th>Status</th><th>Settles</th><th className={styles.num}>Sale price</th><th className={styles.num}>Commission</th><th className={styles.num}>Agent share</th><th className={styles.num}>Agency share</th></tr>
              </thead>
              <tbody>
                {r.deals.length === 0 ? <tr><td colSpan={7} className={styles.muted}>Nothing settled or under contract in this period.</td></tr> : null}
                {r.deals.map((d) => (
                  <tr key={d.id}>
                    <td>{d.listingId ? <Link href={`${listingBase}/${d.listingId}/edit?tab=deal`}>{d.address}</Link> : d.address}{agency && d.agentName ? <span className={styles.muted}> · {d.agentName}</span> : null}</td>
                    <td>{d.commission === null ? <span className={`${styles.pill} ${styles.pillWarn}`}>No commission set</span> : dealStatus(d)}</td>
                    <td>{day(d.settlementDate)}</td>
                    <td className={styles.num}>{money(d.salePrice)}</td>
                    <td className={styles.num}>{money(d.commission)}</td>
                    <td className={styles.num}>{money(d.agentShare)}</td>
                    <td className={styles.num}>{money(d.agencyShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <p className={styles.note}>
        <span className={styles.glyph} aria-hidden>info</span>
        <span>
          Amounts exclude GST. <b>Earned</b>: settled in the period. <b>Expected</b>: under contract now. <b>Paid out</b>: the agent’s share marked paid
          in the period. Each figure is added up from the deals’ Commission panels, worked out by the platform — nothing is estimated. Trust accounting
          stays in the agency’s trust software.
        </span>
      </p>
    </div>
  );
}
