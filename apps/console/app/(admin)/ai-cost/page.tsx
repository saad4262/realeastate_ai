import Link from 'next/link';
import { aiCostOverview, parseAiCostPeriod, type AiCostWho } from '@repo/core/platform';
import { CapBadge, count, FeatureTable, LimitCard, pct, perCall, PeriodTabs, periodWords, ShareBar, SpendChart, TextStat, usd } from '@/components/admin/ai-cost';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformAdmin } from '@/lib/require-platform-admin';

const NOTE: Record<Exclude<AiCostWho['kind'], 'agency'>, string> = {
  public: 'Property chat, buyer tools, alerts',
  unattributed: 'Older rows, and listing photos being indexed',
};

/**
 * What the platform's AI calls have cost (ADR 0086). Read only: limits stay in Vercel's settings. The period
 * lives in the URL; the 24-hour limit and the 30-day chart do not move with it.
 */
export default async function AiCostPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { admin } = await requirePlatformAdmin();
  await recordPlatformView(admin, 'ai_cost');
  const period = parseAiCostPeriod((await searchParams).days);
  const c = await aiCostOverview(getConsoleDb(), admin, { period });

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>AI cost</h1>
          <p className={styles.sub}>
            What the platform’s AI calls have cost, by agency and by feature. Worked out from token counts and our price list, so the
            Anthropic, Voyage and Retell bills stay the final word. US dollars.
          </p>
        </div>
        <PeriodTabs base="/ai-cost" period={period} />
      </div>

      <LimitCard spent={c.daySpend} cap={c.caps.platform} of="in the last 24 hours">
        A rolling 24 hours, not a calendar day, so it falls as older calls drop out. At the limit the assistant, AI skills, alert
        summaries and buyers’ tasks stop. The public property chat and buyer tools have their own daily caps on requests instead, so
        their spend counts here but can carry on past it. The hard ceiling is the spend limit in the Anthropic console.
      </LimitCard>

      {c.attention.length ? (
        <section className={styles.attention}>
          <h2 className={styles.h2}>Needs a look</h2>
          <ul>
            {c.attention.map((a) =>
              a.kind === 'platform' ? (
                <li key="platform">Platform spend is {usd(a.spent)} of the {usd(a.cap)} limit for the last 24 hours.</li>
              ) : a.kind === 'agency' ? (
                <li key={a.agencyId}>
                  <Link href={`/ai-cost/${a.agencyId}?days=${period}`}>{a.name}</Link>’s assistant is at {usd(a.spent)} of its {usd(a.cap)} limit.
                </li>
              ) : (
                <li key="unpriced">
                  {count(a.calls)} {a.calls === 1 ? 'call' : 'calls'} used a model with no price in our list, so {a.calls === 1 ? 'it counts' : 'they count'} as $0.00 here. The model’s price needs adding.
                </li>
              ),
            )}
          </ul>
        </section>
      ) : null}

      <div className={styles.stats}>
        <TextStat label="Spend" value={usd(c.spend)} />
        <TextStat label="AI calls" value={count(c.calls)} />
        <TextStat label="Cost per call" value={perCall(c.spend, c.calls)} />
        <TextStat label="Agencies using AI" value={count(c.agencies)} />
        <TextStat label="Public site share" value={c.spend > 0 ? pct(c.publicSpend / c.spend) : '—'} />
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.h2}>Spend per day</h2>
          <span className={styles.sub}>Last 30 days, Sydney time</span>
        </div>
        <SpendChart days={c.days} cap={c.caps.platform} />
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.h2}>Who it was for</h2>
          <span className={styles.sub}>{periodWords(period)}</span>
        </div>
        {c.who.length ? (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Who</th>
                  <th className={styles.num}>Spend</th>
                  <th>Share</th>
                  <th className={styles.num}>Calls</th>
                  <th>Assistant, 24 hours (limit {usd(c.caps.agency)})</th>
                  <th>Biggest use</th>
                </tr>
              </thead>
              <tbody>
                {c.who.map((w) => (
                  <tr key={w.key}>
                    <td>{w.agencyId ? <Link className={styles.name} href={`/ai-cost/${w.agencyId}?days=${period}`}>{w.name}</Link> : w.name}</td>
                    <td className={styles.num} data-label="Spend">{usd(w.spend)}</td>
                    <td data-label="Share"><ShareBar part={w.spend} whole={c.spend} /></td>
                    <td className={styles.num} data-label="Calls">{count(w.calls)}</td>
                    <td data-label="Assistant, 24 hours">
                      {w.assistantDay === null ? '—' : <>{usd(w.assistantDay)} <CapBadge spent={w.assistantDay} cap={c.caps.agency} /></>}
                    </td>
                    <td data-label="Biggest use">{w.kind === 'agency' ? w.topFeature : <span className={styles.muted}>{NOTE[w.kind]}</span>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td><strong>Total</strong></td>
                  <td className={styles.num} data-label="Spend"><strong>{usd(c.spend)}</strong></td>
                  <td />
                  <td className={styles.num} data-label="Calls"><strong>{count(c.calls)}</strong></td>
                  <td />
                  <td />
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
          <h2 className={styles.h2}>What it was spent on</h2>
          <span className={styles.sub}>{periodWords(period)}</span>
        </div>
        <FeatureTable features={c.features} spend={c.spend} calls={c.calls} />
      </section>

      <p className={styles.sub}>
        Not counted here: Twilio texts and numbers, Google Maps and Resend email, which have their own bills. Voyage’s free allowance is
        not taken off, so its figure can read a little high.
      </p>
    </div>
  );
}
