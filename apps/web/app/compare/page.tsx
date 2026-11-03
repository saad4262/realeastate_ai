import type { Metadata } from 'next';
import Link from 'next/link';
import { MAX_COMPARE, MIN_COMPARE, type BuyerType, type HomeRow } from '@repo/core/research';
import { pausedConsumerSkills } from '@repo/core/consumer-skills/catalog';
import { WebShell } from '../../components/web-shell';
import { HideIfSkillOff } from '../../components/hide-if-skill-off';
import { ResearchAi } from '../../components/research-ai';
import { cachedHomeRows } from '../../lib/cached';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Compare homes', robots: { index: false, follow: true } };

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LETTERS = ['A', 'B', 'C', 'D'];
const BUYERS: Record<BuyerType, string> = { first: 'my first home', home: 'a home I will live in', investor: 'an investment' };

/**
 * Comparison AI (ADR 0080, C5 decision 4; mock docs/mocks/consumer-research.html#compare): 2–4 public listings in a
 * table, every figure from SQL, stamp duty from C1; the AI's trade-offs on a button, each line citing a column.
 */
export default async function ComparePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const ids = (typeof raw.ids === 'string' ? raw.ids.split(',') : []).map((s) => s.trim()).filter((s) => UUID.test(s)).slice(0, MAX_COMPARE);
  const buyer: BuyerType = raw.buyer === 'first' || raw.buyer === 'investor' ? raw.buyer : 'home';
  const rows = ids.length >= MIN_COMPARE ? await cachedHomeRows(ids, buyer) : [];
  const shown = rows ?? [];

  const cell = (r: HomeRow, k: string): string => {
    switch (k) {
      case 'price': return r.price;
      case 'rooms': return [r.bedrooms, r.bathrooms, r.carSpaces].map((x) => (x === null ? '—' : String(x))).join(' · ');
      case 'land': return r.landAreaSqm === null ? '—' : `${r.landAreaSqm} m²`;
      case 'days': return r.daysOnMarket === null ? '—' : `${r.daysOnMarket} days`;
      case 'changes': return r.priceChanges.length ? r.priceChanges.join('; ') : 'None';
      case 'last': return r.lastSale ?? '—';
      default: return r.stampDuty?.status === 'estimate' ? `${AUD.format(r.stampDuty.duty)}${r.stampDuty.exact ? '' : ' (approx.)'}` : r.stampDuty ? 'Not verified' : '—';
    }
  };
  const ROWS: [string, string][] = [['price', 'Price'], ['rooms', 'Beds · baths · cars'], ['land', 'Land'], ['days', 'On the market'], ['changes', 'Price changes'], ['last', 'Last sale here'], ['duty', 'Stamp duty (estimate)']];

  return (
    <WebShell>
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">Compare homes</h1>
        {shown.length < MIN_COMPARE ? (
          <p className="mt-2 text-ink-soft">
            {rows === null ? 'The homes could not be loaded just now. Try again shortly.' : `Choose ${MIN_COMPARE} to ${MAX_COMPARE} homes that are for sale or for rent — from your `}
            {rows === null ? null : (
              <>
                <Link href="/account/shortlist" className="underline">shortlist</Link>.
              </>
            )}
          </p>
        ) : (
          <>
            <form method="get" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
              <input type="hidden" name="ids" value={ids.join(',')} />
              <label htmlFor="buyer">Stamp duty for</label>
              <select id="buyer" name="buyer" defaultValue={buyer} className="rounded-lg border border-line px-2 py-1">
                {Object.entries(BUYERS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <button type="submit" className="rounded-full border border-line bg-white px-3 py-1 font-semibold text-ink">Update</button>
            </form>
            <div className="mt-4 overflow-x-auto rounded-2xl border border-line bg-card p-5">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-soft">
                    <th className="py-2 pr-3" />
                    {shown.map((r, i) => (
                      <th key={r.listingId} className="py-2 pr-3 font-semibold text-ink">
                        <Link href={`/listing/${r.listingId}`} className="hover:underline">{r.address}</Link>
                        <span className="ml-1 rounded bg-sunken px-1 text-[10px] font-bold text-ink-soft">{LETTERS[i]}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map(([k, label]) => (
                    <tr key={k} className="border-t border-line-subtle align-top">
                      <td className="py-2 pr-3 text-ink-soft">{label}</td>
                      {shown.map((r) => (
                        <td key={r.listingId} className="py-2 pr-3 tabular-nums text-ink">{cell(r, k)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-ink-faint">Every figure from this site&rsquo;s listings; stamp duty from each state&rsquo;s published rates (an estimate, not advice). Homes no longer advertised are left out.</p>
            </div>
            {!pausedConsumerSkills().has('comparison') ? (
              <HideIfSkillOff skill="comparison">
                <section className="mt-4 rounded-2xl border border-line bg-card p-5">
                  <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-soft">The trade-offs</h2>
                  <ResearchAi ask={{ kind: 'compare', listingIds: shown.map((r) => r.listingId), buyer }} label="Explain the trade-offs" />
                </section>
              </HideIfSkillOff>
            ) : null}
          </>
        )}
        <p className="mt-4 border-t border-line pt-3 text-xs text-ink-soft">General information. This site does not estimate values or say which home to buy.</p>
      </main>
    </WebShell>
  );
}
