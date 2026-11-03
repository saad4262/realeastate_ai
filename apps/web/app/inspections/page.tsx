import type { Metadata } from 'next';
import Link from 'next/link';
import { buildPlan, dayText, GAP_OPTIONS, INSIDE_OPTIONS, kmText, localDay, parsePlanLink, planQuery, routeUrl, timeText, type DayPlan, type PlanStop } from '@repo/core/inspections';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { WebShell } from '../../components/web-shell';
import { getWebDb } from '../../lib/db';
import { currentWebUser } from '../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Plan your inspections', robots: { index: false, follow: false } };

/**
 * Inspection AI (ADR 0080, C6 decisions 1–4; mock docs/mocks/consumer-inspections.html#plan): the agents' open times
 * for the homes in the link, in order, each stop checked against the buyer's own gap and time inside. Distances are
 * straight lines from PostGIS — never a driving time. The plan lives in its link; nothing is saved. Read fresh on
 * every visit (three reads), so a time the agent moved or removed shows the next time the page opens.
 */

const STATUS: Record<PlanStop['status'], { label: string; tone: string }> = {
  start: { label: 'Start', tone: 'bg-success-soft text-success' },
  fits: { label: 'Fits', tone: 'bg-success-soft text-success' },
  tight: { label: 'Tight', tone: 'bg-notice-soft text-notice' },
  cant: { label: "Can't make it", tone: 'bg-danger-soft text-danger' },
};

/** The plan's link with one home's time swapped, or homes left out. */
function linkWith(plan: DayPlan, change: { swap?: [string, string]; drop?: string }): string {
  const q = new URLSearchParams(planQuery(plan));
  const s = (q.get('s') ?? '').split(',').filter(Boolean);
  if (change.swap) q.set('s', s.map((id) => (id === change.swap![0] ? change.swap![1] : id)).join(','));
  if (change.drop) {
    const dropSessions = new Set(plan.stops.filter((x) => x.home.listingId === change.drop).map((x) => x.session.id));
    q.set('l', (q.get('l') ?? '').split(',').filter((id) => id !== change.drop).join(','));
    q.set('s', s.filter((id) => !dropSessions.has(id)).join(','));
  }
  return `/inspections?${q.toString()}`;
}

export default async function InspectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ask = parsePlanLink(await searchParams);
  const db = getWebDb();
  const user = await currentWebUser();
  const block = (await consumerSkillBlocks(db, user ? { userId: user.id } : null)).get('inspection_planner');

  if (block) {
    return (
      <Shell>
        <p className="mt-2 text-ink-soft">{consumerSkillOffMessage('inspection_planner', block)}</p>
      </Shell>
    );
  }

  let plan: DayPlan | null = null;
  let failed = false;
  if (ask) {
    try {
      plan = await buildPlan(db, ask);
    } catch (err) {
      console.error('[inspections] the plan could not be built', err);
      failed = true;
    }
  }

  if (!plan) {
    return (
      <Shell>
        <p className="mt-2 max-w-prose text-ink-soft">
          {failed
            ? 'The open-home times could not be loaded just now. Try again shortly.'
            : ask
              ? 'None of those homes is advertised now.'
              : 'Choose open homes with “Add to my day” on a listing, or plan from your '}
          {!failed && !ask ? (
            <>
              <Link href="/account/shortlist" className="underline">
                shortlist
              </Link>
              .
            </>
          ) : null}
        </p>
      </Shell>
    );
  }

  const tz = plan.timeZone;
  const route = routeUrl(plan);
  const query = planQuery(plan);
  const when = (s: PlanStop['session']) => `${timeText(s.startsAt, tz)} – ${timeText(s.endsAt, tz)}`;

  return (
    <Shell title={plan.stops.length ? `Your ${dayText(plan.day)}` : undefined}>
      <p className="mt-1 max-w-prose text-ink-soft">
        {plan.stops.length
          ? `${plan.stops.length} open ${plan.stops.length === 1 ? 'home' : 'homes'}, in order. Times are set by the agents and can change; distances are straight lines, not driving.`
          : plan.notThisDay.some((n) => n.nextTime)
            ? 'None of these homes is open for inspection that day.'
            : 'None of these homes has an open-for-inspection time listed. Ask the agent for a private appointment.'}
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="rounded-2xl border border-line bg-card p-5">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-soft">The plan</h2>
          <ol className="m-0 list-none p-0">
            {plan.stops.map((s, i) => (
              <li key={s.session.id}>
                {i > 0 ? (
                  <p className={`my-1 ml-2 border-l-2 border-dashed py-1 pl-3 text-xs ${s.status === 'tight' || s.status === 'cant' ? 'border-notice text-notice' : 'border-line text-ink-faint'}`}>
                    {kmText(s.metresFromPrevious) ? `${kmText(s.metresFromPrevious)} straight line` : 'Distance unknown'} · your gap {plan!.settings.gapMinutes} min
                    {s.status === 'tight' || s.status === 'cant' ? ` · after ${plan!.settings.insideMinutes} min inside you would arrive ${timeText(s.arriveAt, tz)}` : ''}
                  </p>
                ) : null}
                <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-start gap-3 py-2 max-sm:grid-cols-1">
                  <div className="font-semibold tabular-nums text-ink">
                    {timeText(s.session.startsAt, tz)}
                    <span className="block text-xs font-normal text-ink-faint">to {timeText(s.session.endsAt, tz)}</span>
                  </div>
                  <div className="min-w-0">
                    <Link href={`/listing/${s.home.listingId}`} className="font-semibold text-ink hover:underline">
                      {s.home.address}
                    </Link>
                    <p className="text-sm text-ink-soft">{[s.home.bedrooms !== null ? `${s.home.bedrooms} bed` : null, s.home.propertyType, s.home.price].filter(Boolean).join(' · ')}</p>
                    {s.status === 'tight' ? (
                      <p className="mt-2 rounded-lg bg-notice-soft px-3 py-2 text-sm text-ink">
                        Tight: {s.minutesLeft} {s.minutesLeft === 1 ? 'minute' : 'minutes'} of the open home would be left.
                        {s.otherTimes.map((o) => (
                          <Link key={o.id} href={linkWith(plan!, { swap: [s.session.id, o.id] })} className="ml-1 underline">
                            Use its other time, {when(o)}
                          </Link>
                        ))}
                      </p>
                    ) : null}
                    {s.status === 'cant' ? (
                      <div className="mt-2 rounded-lg bg-notice-soft px-3 py-2 text-sm text-ink">
                        <p className="m-0">You can&rsquo;t reach this one after the stop before it.</p>
                        <div className="mt-1 flex flex-wrap gap-3">
                          {s.otherTimes.map((o) => (
                            <Link key={o.id} href={linkWith(plan!, { swap: [s.session.id, o.id] })} className="underline">
                              Use its other time, {when(o)}
                            </Link>
                          ))}
                          {s.conflictsWith ? (
                            <>
                              <Link href={linkWith(plan!, { drop: s.conflictsWith })} className="underline">
                                Keep this one
                              </Link>
                              <Link href={linkWith(plan!, { drop: s.home.listingId })} className="underline">
                                Keep {plan!.stops.find((x) => x.home.listingId === s.conflictsWith)?.home.address ?? 'the other'}
                              </Link>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    <div className="mt-1 flex gap-3 text-xs">
                      <Link href={`/account/inspections/${s.home.listingId}`} className="text-ink-soft underline">
                        Take notes
                      </Link>
                      <Link href={linkWith(plan!, { drop: s.home.listingId })} className="text-ink-soft underline">
                        Remove
                      </Link>
                    </div>
                  </div>
                  <span className={`justify-self-start rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</span>
                </div>
              </li>
            ))}
          </ol>
          {plan.stops.length ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <a href={`/inspections/calendar?${query}`} className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink">
                Add to calendar (.ics)
              </a>
              {route ? (
                <a href={route} target="_blank" rel="noopener noreferrer" className="rounded-full border border-line bg-white px-4 py-2 text-sm font-semibold text-ink">
                  Open the route in Google Maps
                </a>
              ) : null}
              <Link href={`/inspections?${query}`} className="rounded-full border border-line bg-white px-4 py-2 text-sm font-semibold text-ink">
                Link to this plan
              </Link>
            </div>
          ) : null}
          <p className="mt-3 text-xs text-ink-faint">Distances: straight lines between the addresses, from this site&rsquo;s map data. We don&rsquo;t estimate driving time.</p>
        </section>

        <div className="grid content-start gap-4">
          <form method="get" className="rounded-2xl border border-line bg-card p-5 text-sm">
            <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-soft">Your settings</h2>
            <input type="hidden" name="l" value={new URLSearchParams(query).get('l') ?? ''} />
            <input type="hidden" name="s" value={new URLSearchParams(query).get('s') ?? ''} />
            <label className="flex items-center justify-between gap-2 py-1">
              Gap between homes
              <select name="gap" defaultValue={plan.settings.gapMinutes} className="rounded-lg border border-line px-2 py-1">
                {GAP_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2 py-1">
              Time inside each home
              <select name="inside" defaultValue={plan.settings.insideMinutes} className="rounded-lg border border-line px-2 py-1">
                {INSIDE_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="mt-2 rounded-full border border-line bg-white px-3 py-1 font-semibold text-ink">
              Re-check the plan
            </button>
            <p className="mt-2 text-xs text-ink-faint">Nothing is saved but the link.</p>
          </form>

          {plan.notThisDay.length ? (
            <section className="rounded-2xl border border-line bg-card p-5 text-sm">
              <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-soft">Not this day</h2>
              <ul className="m-0 grid list-none gap-2 p-0">
                {plan.notThisDay.map((n) => (
                  <li key={n.home.listingId}>
                    <Link href={`/listing/${n.home.listingId}`} className="font-semibold text-ink hover:underline">
                      {n.home.address}
                    </Link>
                    <span className="block text-ink-soft">
                      {n.reason === 'time_removed' ? 'The time you chose was removed by the agent.' : n.reason === 'another_day' ? 'Its time is on another day.' : n.nextTime ? 'No open home that day.' : 'No open-for-inspection times listed.'}
                      {n.nextTime ? ` Next: ${dayText(localDay(n.nextTime.startsAt, tz))}, ${when(n.nextTime)}.` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
      <p className="mt-4 border-t border-line pt-3 text-xs text-ink-soft">Times are the agents&rsquo; and can change — check the listing before you go. Private appointments are made with the agent.</p>
    </Shell>
  );
}

function Shell({ title, children }: { title?: string | undefined; children: React.ReactNode }) {
  return (
    <WebShell>
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">{title ?? 'Plan your inspections'}</h1>
        {children}
      </main>
    </WebShell>
  );
}
