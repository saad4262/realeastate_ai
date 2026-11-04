import type { Metadata } from 'next';
import Link from 'next/link';
import { AU_STATES, PROPERTY_TYPES } from '@repo/core/listings';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { loadProfile } from '@repo/core/profile';
import {
  findOpportunities,
  opportunityAskFromProfile,
  parseOpportunityLink,
  SIGNAL_KINDS,
  SIGNAL_TEXT,
  signalLine,
  signalNote,
  type Opportunities,
  type OpportunityAsk,
  type SignalKind,
} from '@repo/core/buyer-opportunities';
import { WebShell } from '../../components/web-shell';
import { getWebDb } from '../../lib/db';
import { currentWebUser } from '../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Opportunities', robots: { index: false, follow: false } };

/**
 * Opportunity AI (ADR 0080, C7 decisions 5–8; mock docs/mocks/consumer-discovery.html#opportunities): public homes for
 * sale whose own records show a price reduction, a campaign of 60+ days, or an asking price below this site's median
 * for the same suburb, kind and bedrooms. Every figure from SQL; every sentence ours; never a verdict. Read fresh, so
 * a price change shows the day it happens. The filters live in the link; nothing is saved.
 */

const TONE: Record<SignalKind, string> = {
  price_reduced: 'bg-success-soft text-success',
  long_campaign: 'bg-notice-soft text-notice',
  below_median: 'bg-info-soft text-info',
};

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const db = getWebDb();
  const user = await currentWebUser();
  const blocks = await consumerSkillBlocks(db, user ? { userId: user.id } : null);
  const block = blocks.get('opportunities');
  if (block) {
    return (
      <Shell>
        <p className="mt-2 text-ink-soft">{consumerSkillOffMessage('opportunities', block)}</p>
      </Shell>
    );
  }

  // "Match my profile": only for a signed-in buyer with Personal Property AI on; the link's signals still apply.
  const linked = parseOpportunityLink(params);
  let ask: OpportunityAsk | null = linked;
  let fromProfile = false;
  let profileNote: string | null = null;
  if (params.mine === '1') {
    if (!user) profileNote = 'Sign in, with Personal Property AI on, to match your profile.';
    else if (blocks.has('personal_profile')) profileNote = 'Personal Property AI is off, so there is no profile to match.';
    else {
      const profile = await loadProfile(db, { userId: user.id }).catch(() => null);
      const mine = profile?.on ? opportunityAskFromProfile(profile.facts, linked?.signals ?? []) : null;
      if (mine) {
        ask = mine;
        fromProfile = true;
      } else profileNote = 'Your profile has no suburbs for homes for sale yet.';
    }
  }

  let found: Opportunities | null = null;
  let failed = false;
  if (ask) {
    try {
      found = await findOpportunities(db, ask);
    } catch (err) {
      console.error('[opportunities] could not be read', err);
      failed = true;
    }
  }
  const chosen = new Set<SignalKind>(ask?.signals.length ? ask.signals : SIGNAL_KINDS);

  return (
    <Shell>
      <p className="mt-1 max-w-prose text-ink-soft">Homes for sale whose own records show something worth asking the agent about. These are facts from this site&rsquo;s records, not a judgement of value.</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="rounded-2xl border border-line bg-card p-5">
          {profileNote ? <p className="mb-3 rounded-lg bg-notice-soft px-3 py-2 text-sm text-ink">{profileNote}</p> : null}
          {!ask ? (
            <p className="text-ink-soft">Name a suburb or a state to start{user ? <>, or <Link href="/opportunities?mine=1" className="underline">match your profile</Link></> : null}.</p>
          ) : failed || !found ? (
            <p className="text-ink-soft">The records could not be read just now. Try again shortly.</p>
          ) : (
            <>
              <p className="mb-2 text-sm text-ink-soft">
                {found.area}
                {fromProfile ? ' · from your profile' : ''} · {found.homes.length} {found.homes.length === 1 ? 'home' : 'homes'}
                {found.truncated ? ' (the newest; narrow the area to see more)' : ''}
              </p>
              {found.homes.length === 0 ? <p className="text-ink-soft">No home for sale here shows {chosen.size === SIGNAL_KINDS.length ? 'any of these signals' : 'the signals you chose'} right now.</p> : null}
              <ol className="m-0 list-none p-0">
                {found.homes.map((h) => (
                  <li key={h.listingId} className="border-t border-line-subtle py-4 first:border-t-0 first:pt-0">
                    <h2 className="m-0 text-base font-semibold text-ink">
                      <Link href={`/listing/${h.listingId}`} className="hover:underline">
                        {h.address}
                      </Link>
                    </h2>
                    <p className="m-0 text-sm text-ink-soft">{[h.bedrooms !== null ? `${h.bedrooms} bed` : null, h.bathrooms !== null ? `${h.bathrooms} bath` : null, h.propertyType, h.price].filter(Boolean).join(' · ')}</p>
                    {h.signals.map((s) => (
                      <div key={s.kind} className="mt-2 rounded-lg bg-sunken px-3 py-2 text-sm">
                        <span className={`mr-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${TONE[s.kind]}`}>{SIGNAL_TEXT[s.kind].label}</span>
                        <b className="mt-1 block font-semibold text-ink">{signalLine(s)}</b>
                        <span className="text-xs text-ink-soft">{signalNote(s, found!.medianDaysOnMarket)}</span>
                        <details className="mt-1 text-sm text-ink-soft">
                          <summary className="cursor-pointer text-brand">What this can mean, and what to ask</summary>
                          <p className="my-1">{SIGNAL_TEXT[s.kind].meaning}</p>
                          <ul className="m-0 pl-5">
                            {SIGNAL_TEXT[s.kind].questions.map((q) => (
                              <li key={q}>{q}</li>
                            ))}
                          </ul>
                        </details>
                      </div>
                    ))}
                    <div className="mt-2 flex flex-wrap gap-3 text-xs">
                      <Link href={`/listing/${h.listingId}#before-you-buy`} className="text-ink-soft underline">
                        Before you buy
                      </Link>
                      <Link href={`/chat?ask=${encodeURIComponent(`What should I ask the agent about ${h.address}?`)}`} className="text-ink-soft underline">
                        Ask the guide
                      </Link>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>

        <div className="grid content-start gap-4">
          <form method="get" className="rounded-2xl border border-line bg-card p-5 text-sm">
            <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-soft">Where and what</h2>
            <label className="flex items-center justify-between gap-2 py-1">
              Suburbs
              <input name="suburbs" defaultValue={fromProfile ? '' : (linked?.suburbs.map((s) => s.replace(/\b\w/g, (c) => c.toUpperCase())).join(', ') ?? '')} placeholder="Pakenham, Officer" className="w-40 rounded-lg border border-line px-2 py-1" />
            </label>
            <label className="flex items-center justify-between gap-2 py-1">
              State
              <select name="state" defaultValue={fromProfile ? '' : (linked?.state ?? '')} className="rounded-lg border border-line px-2 py-1">
                <option value="">Any</option>
                {AU_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2 py-1">
              Up to ($)
              <input name="max" inputMode="numeric" defaultValue={ask?.priceTo ?? ''} className="w-28 rounded-lg border border-line px-2 py-1" />
            </label>
            <label className="flex items-center justify-between gap-2 py-1">
              Bedrooms
              <select name="beds" defaultValue={ask?.bedrooms ?? ''} className="rounded-lg border border-line px-2 py-1">
                <option value="">Any</option>
                {[1, 2, 3, 4, 5].map((b) => (
                  <option key={b} value={b}>
                    {b}+
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2 py-1">
              Kind
              <select name="type" defaultValue={ask?.propertyType ?? ''} className="rounded-lg border border-line px-2 py-1">
                <option value="">Any</option>
                {PROPERTY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t[0]!.toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            {user && !blocks.has('personal_profile') ? (
              <label className="flex items-center gap-2 py-1">
                <input type="checkbox" name="mine" value="1" defaultChecked={fromProfile} /> Match my profile
              </label>
            ) : null}
            <h2 className="mb-2 mt-3 text-xs font-bold uppercase tracking-wider text-ink-soft">Signals</h2>
            {SIGNAL_KINDS.map((k) => (
              <label key={k} className="flex items-center justify-between gap-2 py-1">
                <span>
                  <input type="checkbox" name="s" value={k} defaultChecked={chosen.has(k)} /> {SIGNAL_TEXT[k].filter}
                </span>
                <span className="tabular-nums text-ink-faint">{found ? found.counts[k] : ''}</span>
              </label>
            ))}
            <button type="submit" className="mt-3 rounded-full bg-brand px-4 py-2 font-semibold text-brand-ink">
              Show homes
            </button>
            <p className="mt-2 text-xs text-ink-faint">For sale only. The filters live in the link; nothing is saved.</p>
          </form>

          {found && Object.keys(found.emptyWhy).length ? (
            <section className="rounded-2xl border border-line bg-card p-5 text-sm">
              <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-soft">What we can&rsquo;t show yet</h2>
              <ul className="m-0 grid list-none gap-3 p-0">
                {SIGNAL_KINDS.filter((k) => found!.emptyWhy[k]).map((k) => (
                  <li key={k}>
                    <b className="block text-ink">{SIGNAL_TEXT[k].label}</b>
                    <span className="text-ink-soft">{found!.emptyWhy[k]}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-ink-faint">These fill in as homes sell and prices change on this site. We don&rsquo;t import outside sales figures.</p>
            </section>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <WebShell>
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">Opportunities</h1>
        {children}
      </main>
    </WebShell>
  );
}
