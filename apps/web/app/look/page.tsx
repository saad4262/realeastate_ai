import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { lookAskFromParams, lookPageHref, MAX_LOOK_RESULTS } from '@repo/core/visual-search';
import { pausedConsumerSkills } from '@repo/core/consumer-skills/catalog';
import { WebShell } from '../../components/web-shell';
import { HideIfSkillOff } from '../../components/hide-if-skill-off';
import { cachedLook } from '../../lib/cached';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Search by look', robots: { index: false, follow: true } };

const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
const field = 'rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink';

/**
 * Visual Search AI (ADR 0080, C9 decisions 9–11; mock docs/mocks/consumer-media-land.html#visual): words or "more
 * like this photo", within the buyer's filters. Ordered by how alike the photos look; no score, no judgement of a
 * home. No uploads. Below 500 searchable photos it says it is still filling up, with the count.
 */
export default async function LookPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const off = pausedConsumerSkills().has('visual_search');
  const ask = off ? null : lookAskFromParams(raw);
  const result = ask ? await cachedLook(ask) : null;
  const v = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '');

  return (
    <WebShell>
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">Search by look</h1>
        {off ? (
          <p className="mt-2 text-ink-soft">Search by look is paused on this site just now.</p>
        ) : (
          <HideIfSkillOff skill="visual_search">
            <p className="mt-2 text-ink-soft">Describe the look you want — a light-filled kitchen, timber floors, a big garden — and we order homes by how alike their photos look, within your filters.</p>
            <form method="get" className="mt-4 grid gap-2 rounded-2xl border border-line bg-card p-4 sm:grid-cols-6">
              <label className="grid gap-1 text-xs font-semibold text-ink-soft sm:col-span-6">
                The look
                <input name="words" defaultValue={v('words')} maxLength={200} placeholder="light-filled kitchen, timber floors" className={field} />
              </label>
              <label className="grid gap-1 text-xs font-semibold text-ink-soft sm:col-span-2">
                Suburbs
                <input name="suburb" defaultValue={v('suburb')} placeholder="Officer, Pakenham" className={field} />
              </label>
              <label className="grid gap-1 text-xs font-semibold text-ink-soft">
                State
                <select name="state" defaultValue={v('state').toUpperCase()} className={field}>
                  <option value="">Any</option>
                  {STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold text-ink-soft">
                For
                <select name="channel" defaultValue={v('channel') === 'rent' ? 'rent' : 'sale'} className={field}>
                  <option value="sale">Sale</option>
                  <option value="rent">Rent</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold text-ink-soft">
                Up to $
                <input name="price" inputMode="numeric" defaultValue={v('price')} className={field} />
              </label>
              <label className="grid gap-1 text-xs font-semibold text-ink-soft">
                Bedrooms
                <input name="beds" inputMode="numeric" defaultValue={v('beds')} className={field} />
              </label>
              <div className="sm:col-span-6">
                <button type="submit" className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink">Search by look</button>
              </div>
            </form>

            {!result ? null : result.status === 'filling_up' ? (
              <section className="mt-6 rounded-2xl border border-line bg-card p-5">
                <h2 className="font-display text-xl font-semibold text-ink">Still filling up</h2>
                <p className="mt-1 text-ink-soft">
                  Search by look works once there are enough photos to compare. There {result.searchable === 1 ? 'is 1 photo' : `are ${result.searchable} photos`} ready to search on public listings today; it starts at {result.threshold}. Until then, try Similar homes on any listing, or <Link href="/search" className="underline">search by suburb and features</Link>.
                </p>
              </section>
            ) : result.status === 'photo_not_found' ? (
              <p className="mt-6 text-ink-soft">That photo is not on a listing for sale or rent now, or is not ready to search yet.</p>
            ) : result.status === 'unavailable' ? (
              <p className="mt-6 text-ink-soft">Search by look could not run just now. Try again shortly.</p>
            ) : result.homes.length === 0 ? (
              <p className="mt-6 text-ink-soft">No homes within these filters have photos to compare yet. Try fewer filters.</p>
            ) : (
              <section className="mt-6">
                <ul className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
                  {result.homes.slice(0, MAX_LOOK_RESULTS).map((h) => (
                    <li key={h.listingId} className="overflow-hidden rounded-2xl border border-line bg-card">
                      <span className="relative block aspect-[4/3] w-full bg-sunken">
                        <Image src={h.photo.url} alt={h.photo.caption ?? `A photo of ${h.address}`} fill sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw" className="object-cover" />
                      </span>
                      <div className="grid gap-1 p-4">
                        <p className="m-0 font-semibold text-ink">{h.price}</p>
                        <p className="m-0 text-sm text-ink">{h.address}</p>
                        <p className="m-0 text-xs text-ink-soft">{[h.bedrooms !== null ? `${h.bedrooms} bed` : null, h.propertyType].filter(Boolean).join(' · ')}</p>
                        <p className="m-0 text-xs text-ink-faint">Looks similar{h.photo.caption ? ` · ${h.photo.caption.toLowerCase()} photo` : ''}</p>
                        <div className="mt-2 flex gap-3 text-sm">
                          <Link href={lookPageHref({ ...ask!, words: undefined, photoId: h.photo.mediaId })} className="text-brand underline">More like this photo</Link>
                          <Link href={`/listing/${h.listingId}`} className="text-brand underline">View</Link>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-ink-faint">Ordered by how alike the photos look, within your filters. It finds what a photo shows; it doesn&rsquo;t judge the condition or quality of a home.</p>
              </section>
            )}
          </HideIfSkillOff>
        )}
      </main>
    </WebShell>
  );
}
