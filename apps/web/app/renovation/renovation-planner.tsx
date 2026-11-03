'use client';

import { useState, useTransition } from 'react';
import { RENOVATION_CATEGORIES, TRIGGER_LABELS, type PermitTrigger } from '@repo/core/renovation/categories';

type Card = { category: string; name: string; note: string; costDrivers: string[]; trades: string[] };
type Permit = { trigger: PermitTrigger; verified: true; note: string; source: { name: string; url: string; checkedOn: string } } | { trigger: PermitTrigger; verified: false };
type Plan = { state: string | null; cards: Card[]; permits: Permit[] };

const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'] as const;
/** Shortcuts that add a phrase to the box — the model still reads the words, not the chip. */
const CHIPS = ['Kitchen', 'Bathroom', 'Open plan', 'Extension', 'Deck', 'Flooring', 'Painting', 'Re-roof', 'Electrical', 'Landscaping'];

/**
 * The plan (ADR 0080, C3 decisions 2, 3 and 5). Everything it shows came back checked from /api/renovation: the
 * kinds of work from the fixed list, our cost drivers and trades, and each permit note with its official source —
 * or "not verified". The rooms come from /api/renovation/rooms, room types only.
 */
export function RenovationPlanner({ listing }: { listing: { id: string; state: string | null; hasPhotos: boolean } | null }) {
  const [words, setWords] = useState('');
  const [state, setState] = useState(listing?.state ?? '');
  const [rooms, setRooms] = useState<{ room: string; photos: number }[] | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [readingPhotos, startPhotos] = useTransition();

  async function post<T>(url: string, body: unknown): Promise<T | null> {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res?.ok || !data) {
      setError(data?.error ?? 'That did not work. Try again in a moment.');
      return null;
    }
    return data;
  }

  function readPhotos() {
    if (!listing) return;
    setError(null);
    startPhotos(async () => {
      const data = await post<{ rooms: { room: string; photos: number }[] }>('/api/renovation/rooms', { listingId: listing.id });
      if (data) setRooms(data.rooms);
    });
  }

  function makePlan() {
    setError(null);
    start(async () => {
      const data = await post<Plan>('/api/renovation', {
        request: words,
        ...(listing ? { listingId: listing.id } : state ? { state } : {}),
        ...(rooms?.length ? { rooms: rooms.map((r) => r.room) } : {}),
      });
      if (data) setPlan(data);
    });
  }

  const field = 'mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink';
  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <section className="h-fit rounded-2xl border border-line bg-card p-5">
        <h2 className="text-xs font-bold uppercase tracking-wider text-ink-soft">The home</h2>
        {listing ? (
          <div className="mt-2 text-sm">
            {rooms ? (
              <p className="text-ink">
                {rooms.length ? rooms.map((r) => r.room.replace('_', ' ')).join(', ') : 'No rooms recognised in the photos.'}{' '}
                <span className="rounded-full bg-info-soft px-2 py-0.5 text-[11px] font-bold text-info">From the listing photos</span>
              </p>
            ) : listing.hasPhotos ? (
              <button type="button" onClick={readPhotos} disabled={readingPhotos} className="rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-60">
                {readingPhotos ? 'Reading the photos…' : 'What rooms do the photos show?'}
              </button>
            ) : (
              <p className="text-ink-soft">This listing has no photos.</p>
            )}
            <p className="mt-1 text-xs text-ink-faint">Rooms only — the AI never judges condition.</p>
          </div>
        ) : (
          <label className="mt-3 block text-sm font-semibold text-ink">
            State
            <select value={state} onChange={(e) => setState(e.target.value)} className={field}>
              <option value="">Choose for permit notes…</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="mt-4 text-sm font-semibold text-ink">What would you change?</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {CHIPS.map((c) => (
            <button key={c} type="button" onClick={() => setWords((w) => (w.trim() ? `${w.trim()}, ${c.toLowerCase()}` : c))} className="rounded-full border border-line bg-white px-3 py-1 text-xs text-ink-soft hover:border-ink">
              {c}
            </button>
          ))}
        </div>
        <label className="mt-3 block text-sm font-semibold text-ink">
          In your words
          <textarea value={words} onChange={(e) => setWords(e.target.value)} maxLength={1000} rows={5} placeholder="New kitchen with an island, take out the wall to the dining room, a bigger deck…" className={field} />
        </label>
        <button type="button" onClick={makePlan} disabled={pending || words.trim().length < 3} className="mt-4 w-full rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-brand-ink disabled:opacity-60">
          {pending ? 'Making your plan…' : 'Make my plan'}
        </button>
        {error ? <p role="alert" className="mt-2 text-sm text-alert">{error}</p> : null}
      </section>

      <div>
        {plan ? <PlanView plan={plan} /> : <KindsOfWork />}
        <section className="mb-4 rounded-2xl border border-line bg-card p-5">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-soft">What about the cost?</h2>
          <p className="rounded-lg border-l-4 border-info bg-info-soft px-3 py-2 text-sm text-ink">
            We do not show prices for renovation work: there is no official, current price list in Australia, and a figure we could not stand behind would be worse than none. Get at least three written quotes for each part, and compare them below.
          </p>
        </section>
      </div>
    </div>
  );
}

function KindsOfWork() {
  return (
    <section className="mb-4 rounded-2xl border border-line bg-card p-5">
      <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-soft">Your plan</h2>
      <p className="text-sm text-ink-soft">Describe what you would change and press “Make my plan”. It is built from {RENOVATION_CATEGORIES.length} kinds of work, each with what drives its cost and the trades involved.</p>
    </section>
  );
}

function PlanView({ plan }: { plan: Plan }) {
  return (
    <>
      <section className="mb-4 rounded-2xl border border-line bg-card p-5">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-soft">
          Your plan <span className="ml-1 rounded-full bg-info-soft px-2 py-0.5 text-[11px] text-info">Drafted by the property guide</span>
        </h2>
        {plan.cards.length ? (
          plan.cards.map((c) => (
            <article key={c.category} className="border-t border-line-subtle py-3 first:border-t-0 first:pt-0">
              <h3 className="text-base font-semibold text-ink">{c.name}</h3>
              <p className="text-sm text-ink-soft">“{c.note}”</p>
              <p className="mt-2 text-xs font-bold uppercase tracking-wide text-ink-faint">What drives the cost</p>
              <ul className="ml-4 list-disc text-sm text-ink-soft">
                {c.costDrivers.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {c.trades.map((t) => (
                  <span key={t} className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                    {t}
                  </span>
                ))}
              </div>
            </article>
          ))
        ) : (
          <p className="text-sm text-ink-soft">Nothing in that matched the kinds of work we cover. Try describing it differently.</p>
        )}
        <p className="mt-2 text-xs text-ink-faint">The kinds of work, cost drivers and trades are written by us; the AI chose which apply.</p>
      </section>

      {plan.permits.length ? (
        <section className="mb-4 rounded-2xl border border-line bg-card p-5">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-soft">{plan.state} — permits, approvals and licensed trades</h2>
          {plan.permits.map((p) => (
            <div key={p.trigger} className="border-t border-line-subtle py-2.5 text-sm first:border-t-0 first:pt-0">
              <p className="font-semibold text-ink">{TRIGGER_LABELS[p.trigger]}</p>
              {p.verified ? (
                <p className="text-ink-soft">
                  {p.note}{' '}
                  <a href={p.source.url} target="_blank" rel="noopener noreferrer" className="text-xs text-ink-faint underline">
                    {p.source.name}, checked {p.source.checkedOn}
                  </a>
                </p>
              ) : (
                <p className="text-ink-soft">We have not verified {plan.state}’s rule for this yet. A registered building surveyor, a certifier or the council will tell you what applies.</p>
              )}
            </div>
          ))}
        </section>
      ) : plan.state ? null : (
        <p className="mb-4 text-sm text-ink-soft">Choose a state to see the permit notes.</p>
      )}
    </>
  );
}
