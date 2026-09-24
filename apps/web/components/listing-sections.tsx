import type { PublicAgentCard, PublicInspection, PublicTimelineEntry } from '@repo/core/listings';

/**
 * The parts of a property page that are not the property.
 *
 * All Server Components. Nothing here takes an event handler, so nothing here
 * costs the browser anything.
 */

const WHEN = new Intl.DateTimeFormat('en-AU', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const TIME = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit' });
const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});
const DATE = new Intl.DateTimeFormat('en-AU', { month: 'short', year: 'numeric' });

export function Card({
  id,
  title,
  note,
  children,
}: {
  id?: string;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="rounded-lg border border-line-subtle bg-card p-lg shadow-card sm:p-margin"
    >
      <div className="mb-md">
        <h2 className="text-headline-md font-display text-ink">{title}</h2>
        {note ? <p className="mt-1 text-body-sm text-ink-faint">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * A section this platform does not have the data for, said plainly.
 *
 * One line, muted, never a skeleton or a placeholder chart. The mock this page
 * follows carries ten sections of market intelligence, school catchments and
 * inclusion schedules; this database holds none of it. Drawing a convincing
 * empty chart would be inventing the thing #4 exists to forbid, and drawing a
 * full-height "coming soon" panel six times over would make a working page
 * read as broken.
 */
export function NotConnected({ title, what }: { title: string; what: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-sm gap-y-1 rounded-md border border-dashed border-line px-md py-sm">
      <span className="text-label-md uppercase text-ink-faint">{title}</span>
      <span className="text-body-sm text-ink-faint">{what}</span>
    </div>
  );
}

export function Inspections({ inspections }: { inspections: PublicInspection[] }) {
  if (inspections.length === 0) {
    return (
      <Card title="Inspections">
        <p className="text-body-md text-ink-soft">
          No inspection times are scheduled. Ask the agent to arrange one.
        </p>
      </Card>
    );
  }

  return (
    <Card id="inspections" title="Inspections" note="Times the property is open to visit.">
      <ul className="grid gap-sm sm:grid-cols-2">
        {inspections.map((i) => (
          <li
            key={i.id}
            className="rounded-md border border-line-subtle bg-canvas px-md py-sm"
          >
            <div className="flex items-baseline justify-between gap-sm">
              <span className="text-title-sm text-ink">{WHEN.format(i.startsAt)}</span>
              {i.kind !== 'open' ? (
                <span className="rounded-sm bg-brand-soft px-1.5 py-0.5 text-label-sm uppercase text-brand">
                  {i.kind}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 text-body-sm text-ink-soft">
              {TIME.format(i.startsAt)} – {TIME.format(i.endsAt)}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * What has happened at this address.
 *
 * Every figure is `sold_price` as the agency entered it and every date is
 * `sold_date`. Nothing is estimated, modelled or compared to a median — the
 * page has no median and will not invent one.
 */
export function Timeline({
  entries,
  currentListingId,
}: {
  entries: PublicTimelineEntry[];
  currentListingId: string;
}) {
  // One entry that IS this listing tells the reader nothing they cannot see
  // above it.
  const useful = entries.filter((e) => e.listingId !== currentListingId || entries.length > 1);
  if (useful.length === 0) return null;

  return (
    <Card
      id="history"
      title="Property history"
      note="Taken from the listings written against this address."
    >
      <ol className="divide-y divide-line-subtle">
        {useful.map((e) => {
          const when = e.soldDate ?? e.publishedAt;
          const isThis = e.listingId === currentListingId;
          return (
            <li
              key={e.listingId}
              className="flex flex-wrap items-baseline justify-between gap-x-md gap-y-1 py-sm"
            >
              <span className="text-body-sm tabular-nums text-ink-faint">
                {when ? DATE.format(when) : '—'}
              </span>
              <span className="text-body-md text-ink">
                {e.status === 'sold' ? 'Sold' : isThis ? 'This listing' : 'Listed'}
              </span>
              <span className="text-data text-ink">
                {e.soldPrice !== null ? AUD.format(e.soldPrice) : (e.priceDisplay ?? '—')}
              </span>
              <span className="text-body-sm text-ink-faint">{e.agencyName}</span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

export function AgentPanel({
  agents,
  agencyName,
}: {
  agents: PublicAgentCard[];
  agencyName: string;
}) {
  return (
    <div className="rounded-lg border border-line-subtle bg-card p-lg shadow-card">
      <div className="border-b border-line-subtle pb-md">
        <div className="text-label-sm uppercase text-ink-faint">Marketed by</div>
        <div className="mt-0.5 text-headline-md font-display text-ink">{agencyName}</div>
      </div>

      {agents.length === 0 ? (
        <p className="pt-md text-body-sm text-ink-soft">
          Contact details for this listing are not published.
        </p>
      ) : (
        <ul className="grid gap-md pt-md">
          {agents.map((a) => (
            <li key={`${a.name}-${a.phone}`} className="flex items-start gap-sm">
              {a.photoUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element -- agent
                   photos are arbitrary remote URLs stored in agent_profile and
                   next/image needs every host allow-listed in next.config. A
                   plain img is correct until there is one media host. */
                <img
                  src={a.photoUrl}
                  alt=""
                  width={48}
                  height={48}
                  className="size-12 shrink-0 rounded-full border border-line-subtle object-cover"
                />
              ) : (
                <span
                  aria-hidden
                  className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-soft text-title-sm text-brand"
                >
                  {a.name.slice(0, 1)}
                </span>
              )}
              <div className="min-w-0">
                <div className="text-title-sm text-ink">{a.name}</div>
                {a.licenceNumber ? (
                  <div className="text-body-sm text-ink-faint">Licence {a.licenceNumber}</div>
                ) : null}
                <a
                  href={`tel:${a.phone.replace(/\s+/g, '')}`}
                  className="mt-0.5 inline-block text-data text-brand hover:underline"
                >
                  {a.phone}
                </a>
                {a.bio ? (
                  <p className="mt-1 text-body-sm leading-snug text-ink-soft">{a.bio}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
