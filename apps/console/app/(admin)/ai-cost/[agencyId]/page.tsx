import Link from 'next/link';
import { aiCostForAgency, parseAiCostPeriod } from '@repo/core/platform';
import { CapBadge, count, credits, FeatureTable, LimitCard, pct, perCall, PeriodTabs, periodWords, TextStat, usd } from '@/components/admin/ai-cost';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformView } from '@/lib/require-platform-admin';

const GRANT: Record<string, string> = { plan: 'Plan allowance', topup: 'Top-up', admin: 'Given by the platform' };
const day = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeZone: 'Australia/Sydney' });

/** One agency's AI spend, by person and by feature (ADR 0086). Read only and logged, like every page about an agency. */
export default async function AgencyAiCostPage({
  params,
  searchParams,
}: {
  params: Promise<{ agencyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { agencyId } = await params;
  const view = await requirePlatformView(agencyId);
  await recordPlatformView(view.actor, 'ai_cost', agencyId);
  const period = parseAiCostPeriod((await searchParams).days);
  const c = await aiCostForAgency(getConsoleDb(), view.admin, agencyId, { period });

  return (
    <div className={styles.wrap}>
      <p className={styles.crumbs}>
        <Link href={`/ai-cost?days=${period}`}>AI cost</Link> / {view.agencyName}
      </p>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>{view.agencyName}</h1>
          <p className={styles.sub}>
            This agency’s AI spend. Morning Brief, Important emails and floorplan reading from before this page was added are not
            in it: they are under “Not tied to an agency”.
          </p>
        </div>
        <PeriodTabs base={`/ai-cost/${agencyId}`} period={period} />
      </div>

      <LimitCard spent={c.assistantDay} cap={c.caps.agency} of="assistant limit, last 24 hours">
        At this limit the agency’s assistant stops until the spend falls. Workflow AI has its own daily limit.
      </LimitCard>

      <div className={styles.stats}>
        <TextStat label="Spend" value={usd(c.spend)} />
        <TextStat label="AI calls" value={count(c.calls)} />
        <TextStat label="Cost per call" value={perCall(c.spend, c.calls)} />
        <TextStat label="Share of the platform" value={pct(c.shareOfPlatform)} />
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.h2}>By person</h2>
          <span className={styles.sub}>{periodWords(period)}</span>
        </div>
        {c.people.length ? (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Person</th>
                  <th className={styles.num}>Spend</th>
                  <th className={styles.num}>Calls</th>
                  <th>Assistant, 24 hours (limit {usd(c.caps.person)})</th>
                </tr>
              </thead>
              <tbody>
                {c.people.map((p) => (
                  <tr key={p.key}>
                    <td>
                      {p.name}
                      {p.role ? <small className={styles.cellNote}>{p.role}</small> : null}
                    </td>
                    <td className={styles.num} data-label="Spend">{usd(p.spend)}</td>
                    <td className={styles.num} data-label="Calls">{count(p.calls)}</td>
                    <td data-label="Assistant, 24 hours">
                      {p.assistantDay === null ? '—' : <>{usd(p.assistantDay)} <CapBadge spent={p.assistantDay} cap={c.caps.person} /></>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td><strong>Total</strong></td>
                  <td className={styles.num} data-label="Spend"><strong>{usd(c.spend)}</strong></td>
                  <td className={styles.num} data-label="Calls"><strong>{count(c.calls)}</strong></td>
                  <td data-label="Assistant, 24 hours"><strong>{usd(c.assistantDay)}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className={styles.empty}>No AI calls in this period.</p>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.h2}>By feature</h2>
          <span className={styles.sub}>{periodWords(period)}</span>
        </div>
        <FeatureTable features={c.features} spend={c.spend} calls={c.calls} />
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.h2}>AI credits</h2>
          <span className={styles.sub}>{c.creditsLeft === null ? 'No grant in force' : `${credits(c.creditsLeft)} left in grants in force`}</span>
        </div>
        {c.grants.length ? (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Grant</th>
                  <th className={styles.num}>Credits</th>
                  <th className={styles.num}>Used</th>
                  <th>From</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {c.grants.map((g) => (
                  <tr key={g.id}>
                    <td>
                      {GRANT[g.source] ?? g.source} {g.active ? null : <span className={styles.muted}>(not in force)</span>}
                    </td>
                    <td className={styles.num} data-label="Credits">{count(g.credits)}</td>
                    <td className={styles.num} data-label="Used">{count(Math.round(g.used))}</td>
                    <td data-label="From">{day.format(g.validFrom)}</td>
                    <td data-label="Expires">{day.format(g.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.empty}>No credit grants: a trial, or billing not set up. Its AI runs against the daily limits only.</p>
        )}
      </section>

      {c.chats.length ? (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h2 className={styles.h2}>The assistant, by chat</h2>
            <span className={styles.sub}>{periodWords(period)}</span>
          </div>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Chat</th>
                  <th className={styles.num}>Spend</th>
                  <th className={styles.num}>Calls</th>
                  <th className={styles.num}>Per call</th>
                </tr>
              </thead>
              <tbody>
                {c.chats.map((l) => (
                  <tr key={l.key}>
                    <td>{l.label}</td>
                    <td className={styles.num} data-label="Spend">{usd(l.spend)}</td>
                    <td className={styles.num} data-label="Calls">{count(l.calls)}</td>
                    <td className={styles.num} data-label="Per call">{perCall(l.spend, l.calls)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
