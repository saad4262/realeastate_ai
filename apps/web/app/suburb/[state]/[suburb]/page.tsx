import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CENSUS_SOURCE, MEDIAN_MIN_SALES, MEDIAN_WINDOW_MONTHS, type SuburbProfile } from '@repo/core/research';
import { pausedConsumerSkills } from '@repo/core/consumer-skills/catalog';
import { WebShell } from '../../../../components/web-shell';
import { HideIfSkillOff } from '../../../../components/hide-if-skill-off';
import { ResearchAi } from '../../../../components/research-ai';
import { cachedSuburbProfile } from '../../../../lib/cached';

/** Cached and sessionless, as the listing pages: the hour matches the readers' (ADR 0080 C5 decision 6). */
export const revalidate = 3600;

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const fromSlug = (s: string) => decodeURIComponent(s).replace(/-/g, ' ').trim();

type Params = { params: Promise<{ state: string; suburb: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { state, suburb } = await params;
  const name = fromSlug(suburb).replace(/\b\w/g, (c) => c.toUpperCase());
  return { title: `${name}, ${state.toUpperCase()} — suburb profile`, description: `What this site's listings show about ${name}, and the ABS 2021 Census housing figures.` };
}

function Kpi({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-sunken px-4 py-3">
      <p className="text-xl font-bold tabular-nums text-ink">{value}</p>
      <p className="text-xs text-ink-soft">{label}</p>
    </div>
  );
}

function OurFigures({ p }: { p: SuburbProfile }) {
  return (
    <section className="mb-4 rounded-2xl border border-line bg-card p-5">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-soft">
        From listings on this site <span className="ml-1 rounded-full bg-sunken px-2 py-0.5 text-[11px]">Not the whole market</span>
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi value={String(p.forSale)} label={`For sale now${p.forRent ? ` · ${p.forRent} for rent` : ''}`} />
        <Kpi value={p.medianSold ? AUD.format(p.medianSold.value) : '—'} label={p.medianSold ? `Median sold, last ${MEDIAN_WINDOW_MONTHS} months — ${p.medianSold.sales} sales` : `Median sold: not enough sales on this site yet (${p.salesInWindow} in ${MEDIAN_WINDOW_MONTHS} months)`} />
        <Kpi value={p.medianDays ? `${p.medianDays.value} days` : '—'} label={p.medianDays ? `Median days on the market — ${p.medianDays.sales} sales` : 'Median days on the market: not enough sales'} />
      </div>
      {!p.medianSold ? (
        <p className="mt-3 rounded-lg border-l-4 border-notice bg-notice-soft px-3 py-2 text-sm text-ink">
          A median needs at least {MEDIAN_MIN_SALES} sales on this site in {MEDIAN_WINDOW_MONTHS} months. The sales we do have are listed below.
        </p>
      ) : null}
      <h3 className="mt-4 text-base font-semibold text-ink">Recent sales</h3>
      {p.recentSales.length ? (
        <ul className="m-0 list-none p-0">
          {p.recentSales.map((s, i) => (
            <li key={i} className="flex justify-between gap-3 border-t border-line-subtle py-2 text-sm first:border-t-0">
              <span className="text-ink">
                {s.address}
                {s.bedrooms !== null ? ` · ${s.bedrooms} bed` : ''}
                {s.propertyType ? ` ${s.propertyType.toLowerCase()}` : ''}
              </span>
              <span className="whitespace-nowrap text-ink-soft">
                {s.price} · {s.soldOn.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-soft">No sales on this site in the last {MEDIAN_WINDOW_MONTHS} months.</p>
      )}
    </section>
  );
}

function Census({ p }: { p: SuburbProfile }) {
  const c = p.census;
  if (!c) return <p className="mb-4 text-sm text-ink-soft">No ABS Census figures for this suburb name.</p>;
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
  return (
    <section className="mb-4 rounded-2xl border border-line bg-card p-5">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-soft">
        ABS Census 2021 <span className="ml-1 rounded-full bg-sunken px-2 py-0.5 text-[11px]">Public data</span>
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi value={c.population === null ? '—' : c.population.toLocaleString('en-AU')} label="People" />
        <Kpi value={c.medianRentWeekly === null ? '—' : AUD.format(c.medianRentWeekly)} label="Median weekly rent" />
        <Kpi value={c.medianMortgageMonthly === null ? '—' : AUD.format(c.medianMortgageMonthly)} label="Median monthly mortgage repayment" />
      </div>
      <ul className="m-0 mt-3 list-none p-0 text-sm">
        <li className="flex justify-between border-t border-line-subtle py-2 first:border-t-0"><span>Separate houses · semi-detached or townhouses · flats</span><span>{pct(c.separateHousePct)} · {pct(c.semiDetachedPct)} · {pct(c.flatPct)}</span></li>
        <li className="flex justify-between border-t border-line-subtle py-2"><span>Owned outright · with a mortgage · rented</span><span>{pct(c.ownedOutrightPct)} · {pct(c.ownedMortgagePct)} · {pct(c.rentedPct)}</span></li>
        <li className="flex justify-between border-t border-line-subtle py-2"><span>Average people per household</span><span>{c.avgHouseholdSize ?? '—'}</span></li>
      </ul>
      <p className="mt-2 text-xs text-ink-faint">
        <a href={CENSUS_SOURCE.url} target="_blank" rel="noopener noreferrer" className="underline">{CENSUS_SOURCE.name}</a> — figures from August 2021. Shares worked out from the census counts.
      </p>
    </section>
  );
}

/**
 * Suburb AI (ADR 0080, C5; mock docs/mocks/consumer-research.html#suburb). Public and cached; the AI paragraph is a
 * button, hidden when the buyer switched Suburb AI off or the platform paused it. `?vs=` puts a second suburb beside.
 */
export default async function SuburbPage({ params, searchParams }: Params) {
  const { state, suburb } = await params;
  const vs = (await searchParams).vs;
  const p = await cachedSuburbProfile(state, fromSlug(suburb));
  if (p === 'down') throw new Error('The suburb could not be loaded');
  if (!p) notFound();
  const other = typeof vs === 'string' && vs.trim() ? await cachedSuburbProfile(state, fromSlug(vs)) : null;
  const paused = pausedConsumerSkills().has('suburb_insights');

  return (
    <WebShell>
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
          {p.suburb}, {p.state}
        </h1>
        <p className="mt-1 text-ink-soft">
          What this site&rsquo;s listings show, and the ABS Census.{' '}
          <Link href={`/search?channel=sale&suburb=${encodeURIComponent(p.suburb)}&state=${p.state}`} className="underline">
            Homes for sale in {p.suburb}
          </Link>
        </p>
        <form method="get" className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="vs" className="text-ink-soft">Compare with another {p.state} suburb</label>
          <input id="vs" name="vs" defaultValue={typeof vs === 'string' ? vs : ''} placeholder="e.g. Officer" className="rounded-lg border border-line px-2 py-1" />
          <button type="submit" className="rounded-full border border-line bg-white px-3 py-1 font-semibold">Compare</button>
        </form>

        <div className={`mt-6 grid gap-4 ${other && other !== 'down' ? 'lg:grid-cols-2' : 'lg:grid-cols-[minmax(0,1fr)_340px]'}`}>
          <div>
            {other && other !== 'down' ? <h2 className="mb-2 text-lg font-semibold text-ink">{p.suburb}</h2> : null}
            <OurFigures p={p} />
            <Census p={p} />
          </div>
          {other && other !== 'down' ? (
            <div>
              <h2 className="mb-2 text-lg font-semibold text-ink">{other.suburb}</h2>
              <OurFigures p={other} />
              <Census p={other} />
            </div>
          ) : (
            <div>
              {!paused ? (
                <HideIfSkillOff skill="suburb_insights">
                  <section className="mb-4 rounded-2xl border border-line bg-card p-5">
                    <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-soft">In plain words</h2>
                    <ResearchAi ask={{ kind: 'suburb', state: p.state, suburb: p.suburb }} label="Summarise with AI" />
                  </section>
                </HideIfSkillOff>
              ) : null}
            </div>
          )}
        </div>
        {other === null && typeof vs === 'string' && vs.trim() ? <p className="text-sm text-ink-soft">No suburb called “{vs}” in {p.state}.</p> : null}
        <p className="mt-2 border-t border-line pt-3 text-xs text-ink-soft">General information. This site does not estimate values or predict prices. Figures from this site are its own listings, not the whole market.</p>
      </main>
    </WebShell>
  );
}
