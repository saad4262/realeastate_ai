'use client';

import { useEffect, useMemo, useState } from 'react';
import { RENOVATION_CATEGORIES, type RenovationCategoryKey } from '@repo/core/renovation/categories';
import { compareQuotes, formatCents, MIN_QUOTES, quotesSchema, readDollarsToCents, type Quote } from '@repo/core/renovation/quotes';

/**
 * The buyer's quotes, compared (ADR 0080, C3 decision 4) — the only figures on the page, all typed by the buyer.
 * Every sum and difference is `compareQuotes` in core, in whole cents; this component only takes input and shows
 * the result. Kept in this browser per home (a per-viewer convenience), inside try/catch: blocked storage still
 * works, it just forgets.
 */
export function QuoteCompare({ scope }: { scope: string }) {
  const key = `renovation-quotes:${scope}`;
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [category, setCategory] = useState<RenovationCategoryKey>('kitchen');
  const [trade, setTrade] = useState('');
  const [amount, setAmount] = useState('');
  const [includes, setIncludes] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const parsed = quotesSchema.safeParse(JSON.parse(window.localStorage.getItem(key) ?? '[]'));
      if (parsed.success) setQuotes(parsed.data);
    } catch {
      // No storage: start empty.
    }
  }, [key]);

  function save(next: Quote[]) {
    setQuotes(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // As above.
    }
  }

  function add() {
    const cents = readDollarsToCents(amount);
    if (!trade.trim()) return setError('Who gave the quote?');
    if (cents === null) return setError('Type the amount as written on the quote, e.g. 38,500 or 38,500.50.');
    setError(null);
    save([...quotes, { id: crypto.randomUUID(), category, trade: trade.trim().slice(0, 80), amountCents: cents, includes: includes.trim().slice(0, 500) }]);
    setTrade('');
    setAmount('');
    setIncludes('');
  }

  const result = useMemo(() => (quotes.length ? compareQuotes(quotes) : null), [quotes]);
  const field = 'mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink';

  return (
    <section className="mt-2 rounded-2xl border border-line bg-card p-5">
      <h2 className="text-xs font-bold uppercase tracking-wider text-ink-soft">Your quotes</h2>
      <p className="mt-1 text-sm text-ink-soft">Type each written quote you get. Kept in this browser only.</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_10rem]">
        <label className="text-sm font-semibold text-ink">
          Work
          <select value={category} onChange={(e) => setCategory(e.target.value as RenovationCategoryKey)} className={field}>
            {RENOVATION_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-semibold text-ink">
          From
          <input value={trade} onChange={(e) => setTrade(e.target.value)} maxLength={80} placeholder="e.g. Builder A" className={field} />
        </label>
        <label className="text-sm font-semibold text-ink">
          Amount
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="38,500" className={field} />
        </label>
      </div>
      <label className="mt-3 block text-sm font-semibold text-ink">
        What it includes
        <input value={includes} onChange={(e) => setIncludes(e.target.value)} maxLength={500} placeholder="e.g. cabinets, stone benchtop, plumbing; no appliances" className={field} />
      </label>
      <button type="button" onClick={add} className="mt-3 rounded-full border border-line bg-white px-4 py-2 text-sm font-semibold text-ink hover:border-ink">
        Add quote
      </button>
      {error ? <p role="alert" className="mt-2 text-sm text-alert">{error}</p> : null}

      {result ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="py-1.5 font-semibold">Work</th>
                <th className="py-1.5 font-semibold">From</th>
                <th className="py-1.5 font-semibold">Includes</th>
                <th className="py-1.5 text-right font-semibold">Quote</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {result.groups.flatMap((g) =>
                g.quotes.map((q, i) => (
                  <tr key={q.id} className="border-t border-line-subtle align-top">
                    <td className="py-2">
                      {i === 0 ? (
                        <>
                          <span className="font-semibold text-ink">{g.name}</span>
                          {g.needMoreQuotes ? <span className="block text-[11px] text-notice">Get at least {MIN_QUOTES} quotes</span> : null}
                          {g.quotes.length > 1 ? <span className="block text-[11px] text-ink-faint">Spread {formatCents(g.spreadCents)}</span> : null}
                        </>
                      ) : null}
                    </td>
                    <td className="py-2 text-ink">
                      {q.trade}
                      {q.id === g.lowest.id && g.quotes.length > 1 ? <span className="ml-1 rounded-full bg-success-soft px-1.5 text-[10px] font-bold text-success">Lowest</span> : null}
                    </td>
                    <td className="py-2 text-ink-soft">{q.includes || '—'}</td>
                    <td className="py-2 text-right tabular-nums text-ink">{formatCents(q.amountCents)}</td>
                    <td className="py-2 pl-2 text-right">
                      <button type="button" onClick={() => save(quotes.filter((x) => x.id !== q.id))} className="text-xs text-ink-faint underline">
                        Remove
                      </button>
                    </td>
                  </tr>
                )),
              )}
              <tr className="border-t border-line font-bold">
                <td className="py-2" colSpan={3}>
                  Lowest quote for each piece of work
                </td>
                <td className="py-2 text-right tabular-nums">{formatCents(result.lowestTotalCents)}</td>
                <td />
              </tr>
              <tr className="font-semibold text-ink-soft">
                <td className="py-1" colSpan={3}>
                  Highest quote for each piece of work
                </td>
                <td className="py-1 text-right tabular-nums">{formatCents(result.highestTotalCents)}</td>
                <td />
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-faint">Added up by the page from the figures you typed. Compare what each quote includes before comparing the price.</p>
        </div>
      ) : null}
    </section>
  );
}
