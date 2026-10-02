import Link from 'next/link';
import type { PublicSearchQuery } from '@repo/core/listings';
import { cachedNearbySuburbs, cachedTopAgents } from '../../lib/cached';

/**
 * What a portal puts beside its results, minus everything this database cannot
 * answer.
 *
 * The reference sidebar is four panels: median house price, median unit price,
 * average days on market, rental yield, a twelve-month trend line, a mortgage
 * calculator, top agents, and nearby suburbs. Six of those need a market data
 * source this platform does not have, and a median invented to fill the space
 * is precisely the fabricated number non-negotiable #4 exists to forbid — it
 * would look right, it would be quoted back, and nothing on the page would say
 * where it came from.
 *
 * So two panels, both counted from live listings in this database:
 *
 *   Top agents      — who actually has listings in this suburb, and how many.
 *   Nearby suburbs  — where else has something, ordered by real distance.
 *
 * Both are one query each (query-count.test.ts), both are cached for five
 * minutes behind the listings tag, and both swallow their own failures: the
 * sidebar is the least important thing on this page and must never be able to
 * take the results down with it.
 *
 * The panels render nothing at all when they have nothing to say. An empty
 * "Top Agents" frame is a page that looks broken; no frame is a page with one
 * fewer thing on it.
 */

export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-md border border-line-subtle bg-card shadow-card">
      <h2 className="border-b border-line-subtle px-md py-sm text-label-md uppercase text-ink-soft">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** "3 listings" / "1 listing" — a real count, so it has to read as one. */
function listingsLabel(n: number): string {
  return `${n} ${n === 1 ? 'listing' : 'listings'}`;
}

/**
 * The agents selling in this suburb, by how much they have live.
 *
 * Deliberately not "Top agents" in the reference's sense — that is a ranking by
 * sales volume and review score, neither of which this platform records. The
 * heading says what the number underneath it actually is.
 */
export async function TopAgentsPanel({
  suburb,
  state,
  channel,
}: {
  suburb: string;
  state?: string;
  channel?: PublicSearchQuery['channel'];
}) {
  const agents = await cachedTopAgents({ suburb, state, channel });
  if (!agents.length) return null;

  return (
    <Panel title={`Agents listing in ${suburb}`}>
      <ul className="m-0 list-none divide-y divide-line-subtle p-0">
        {agents.map((agent) => (
          <li key={agent.userId} className="flex items-center gap-md px-md py-sm">
            {/*
              Initials, not an avatar.

              `user.avatar_url` exists and nothing populates it, and a broken
              image is worse than none. Two letters in a tinted circle is what
              a portal falls back to anyway.
            */}
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-label-md uppercase text-brand"
            >
              {agent.name
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0] ?? '')
                .join('')}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body-md text-ink">{agent.name}</span>
              <span className="block truncate text-body-sm text-ink-soft">{agent.agencyName}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-data text-ink">{agent.listingCount}</span>
              <span className="block text-label-sm uppercase text-ink-faint">
                {agent.listingCount === 1 ? 'listing' : 'listings'}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * Where else to look, and a real search behind each one.
 *
 * Every entry is a link to a search this site can actually run — the same
 * channel the visitor is browsing, with the suburb, state and postcode that
 * make it exact. There is a Richmond in four states, and a suggestion that
 * lands on the wrong one is worse than no suggestion.
 */
export async function NearbySuburbsPanel({
  suburb,
  state,
  channel,
  near,
}: {
  suburb?: string;
  state?: string;
  channel?: PublicSearchQuery['channel'];
  near?: PublicSearchQuery['near'];
}) {
  const suburbs = await cachedNearbySuburbs({ suburb, state, channel, near });
  if (!suburbs.length) return null;

  const href = (s: { suburb: string; state: string; postcode: string }) => {
    const params = new URLSearchParams({
      suburb: s.suburb,
      state: s.state,
      postcode: s.postcode,
    });
    if (channel) params.set('channel', channel);
    return `/search?${params}`;
  };

  return (
    <Panel title={suburb ? `Suburbs near ${suburb}` : 'Other suburbs'}>
      <ul className="m-0 list-none divide-y divide-line-subtle p-0">
        {suburbs.map((s) => (
          <li key={`${s.suburb}-${s.postcode}`}>
            <Link
              href={href(s)}
              prefetch={false}
              className="flex items-center justify-between gap-sm px-md py-sm hover:bg-sunken"
            >
              <span className="min-w-0">
                <span className="block truncate text-body-md text-ink">{s.suburb}</span>
                <span className="block text-body-sm text-ink-soft">
                  {s.state} {s.postcode}
                  {/* Only when the search had a centre to measure from. */}
                  {s.distanceKm !== null ? ` · ${s.distanceKm.toFixed(1)} km` : ''}
                </span>
              </span>
              <span className="shrink-0 text-label-md uppercase text-brand">
                {listingsLabel(s.listingCount)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * The one panel that says what is missing.
 *
 * Without it the sidebar quietly has no market data and the page reads as
 * finished. The listing page took the same approach for the same reason: one
 * honest line beats five convincing empty frames, and beats a plausible
 * median absolutely.
 */
export function NotConnectedPanel() {
  return (
    <Panel title="Market insights">
      <p className="px-md py-sm text-body-sm text-ink-soft">
        Median prices, days on market and rental yields need a market data
        source, and none is connected. Nothing here is estimated.
      </p>
    </Panel>
  );
}
