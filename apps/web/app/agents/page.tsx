import type { Metadata } from 'next';
import Link from 'next/link';
import { parseLoc, type PlaceRef } from '@repo/core/listings/url';
import { MAX_SEARCH_PLACES } from '@repo/core/listings/schema';
import { WebShell } from '../../components/web-shell';
import { cachedLocalAgents } from '../../lib/cached';
import { portalFonts } from '../portal-fonts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Find a local agent — Property Platform',
};

/**
 * Find agents (ADR 0099): who is selling in these suburbs, or by name.
 *
 * Every figure is a count from SQL (`findLocalAgents`), never a score or a
 * rank someone could pay for — the order is simply most sold, then most for
 * sale. Only what the agent's public listings already print is shown.
 */
export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
  const places = list(params.loc)
    .map(parseLoc)
    .filter((p): p is PlaceRef => p !== null)
    .slice(0, MAX_SEARCH_PLACES);
  const name = list(params.q)[0]?.trim().slice(0, 80) || undefined;

  const { agents, down } =
    places.length || name ? await cachedLocalAgents({ places, name }) : { agents: [], down: false };

  const where = places.map((p) => p.suburb).join(', ');
  const heading = where
    ? `Real estate agents in ${where}`
    : name
      ? `Agents matching “${name}”`
      : 'Find a local agent';

  return (
    <WebShell wide>
      <div data-skin="portal" className={`${portalFonts} min-h-screen bg-canvas`}>
        <div className="mx-auto w-full max-w-[900px] px-gutter py-xl">
          <h1 className="text-headline-xl font-display text-ink">{heading}</h1>

          <form action="/agents" method="get" className="mt-md flex gap-sm" role="search">
            <input
              name="q"
              defaultValue={name ?? ''}
              maxLength={80}
              placeholder="An agent's or agency's name"
              aria-label="Search agents by name"
              className="min-w-0 flex-1 rounded-full border border-line-strong bg-card px-md py-sm text-body-md text-ink"
            />
            <button type="submit" className="rounded-full bg-brand px-lg py-sm font-semibold text-brand-ink">
              Search
            </button>
          </form>
          <p className="mt-sm text-body-sm text-ink-faint">
            Or search a suburb from the <Link href="/" className="text-info underline">home page</Link>{' '}
            (Agents tab). Counts are from listings on this site: for sale now, and sold in the last 12 months.
          </p>

          <div className="mt-lg grid gap-sm">
            {down ? (
              <p className="text-body-md text-ink-soft">Agents are temporarily unavailable. Please try again shortly.</p>
            ) : agents.length ? (
              agents.map((a) => (
                <article
                  key={a.userId}
                  className="flex flex-wrap items-center gap-md rounded-lg border border-line bg-card p-md"
                >
                  <span
                    aria-hidden
                    className="grid h-12 w-12 flex-none place-items-center rounded-full bg-sunken font-semibold text-ink-soft"
                  >
                    {a.name
                      .split(/\s+/)
                      .map((w) => w[0])
                      .slice(0, 2)
                      .join('')
                      .toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-title-sm font-semibold text-ink">{a.name}</h2>
                    <p className="text-body-sm text-ink-soft">{a.agencyName}</p>
                  </div>
                  <dl className="flex gap-lg text-body-sm">
                    <div>
                      <dt className="text-ink-faint">For sale</dt>
                      <dd className="font-semibold text-ink">{a.forSale}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Sold (12 mo)</dt>
                      <dd className="font-semibold text-ink">{a.soldLastYear}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Median days</dt>
                      <dd className="font-semibold text-ink">{a.medianDaysOnMarket ?? '—'}</dd>
                    </div>
                  </dl>
                </article>
              ))
            ) : places.length || name ? (
              <p className="text-body-md text-ink-soft">
                No agents have listed or sold {where ? `in ${where}` : 'under that name'} on this site in the last 12 months.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </WebShell>
  );
}
