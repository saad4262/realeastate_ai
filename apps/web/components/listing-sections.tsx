import type { PublicAgentCard, PublicInspection, PublicTimelineEntry } from '@repo/core/listings';
import Image from 'next/image';
import { mediaUrl } from '@repo/core/media/url';
import { Icon, type IconName } from './icons';

/**
 * The parts of a property page that are not the property.
 *
 * Built to `docs/mocks/listing-detail.html` — the Stitch screen this project
 * was designed from — section by section, and to its tokens rather than to a
 * screenshot of it.
 *
 * All Server Components. Nothing here takes an event handler, so nothing here
 * costs the browser anything.
 *
 * ## What the mock asks for and this database does not have
 *
 * The mock is a full portal page: a 24-photo gallery, an energy rating, an
 * inclusions schedule, an interactive floorplan, CoreLogic medians, a rental
 * yield, days on market, school catchments, a mortgage estimator and a council
 * zoning line. Checked against `schema.ts`, this platform holds **none** of
 * them. What it does hold is the price, the address, the room counts, the land
 * size, the description, the inspection times, the property's own transaction
 * history and who to call.
 *
 * So the sections below are the ones with a source. The rest are named once,
 * in a line, rather than drawn as convincing empty panels — a plausible median
 * is exactly the invented number non-negotiable #4 exists to forbid, and it
 * would be quoted back at us with nothing on the page to say where it came
 * from.
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
/**
 * The full day, not just the month.
 *
 * This was month-and-year, which was right for a four-column table where the
 * year also sat in its own cell. In the timeline the year is already in the
 * margin, so "Sold Jun 2026" repeated it and dropped the one part a reader
 * actually wants — the exact date a sale settled, which is what makes two
 * sales at the same address comparable.
 */
const DATE = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

/* ------------------------------------------------------------------ shell -- */

/**
 * One panel.
 *
 * `eyebrow` is the small coloured label the mock puts above nearly every
 * heading — "PROPERTY TELEMETRY & VALUATION", "UPCOMING INSPECTION SESSIONS",
 * "LOCAL NEIGHBOURHOOD". It carries most of the page's density, and leaving it
 * out was one of the things that made the first attempt read as a plainer
 * design rather than this one.
 *
 * `action` is the right-hand slot the mock uses for a chip or a link on the
 * same line as the heading.
 *
 * `scroll-mt` matters because the in-page tab bar is sticky: without it every
 * anchor lands with its heading underneath the bar that just took you there.
 */
export function Card({
  id,
  eyebrow,
  title,
  note,
  action,
  children,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  note?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-28 rounded-xl border border-line-subtle bg-card p-lg shadow-card sm:p-margin"
    >
      <div className="mb-md flex flex-wrap items-start justify-between gap-sm">
        <div>
          {eyebrow ? (
            <p className="text-label-sm uppercase tracking-wide text-brand">{eyebrow}</p>
          ) : null}
          <h2 className="font-display text-headline-lg text-ink">{title}</h2>
          {note ? <p className="mt-1 text-body-sm text-ink-faint">{note}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** The mock's small status pills. Colour is meaning, never decoration. */
export function Chip({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: 'neutral' | 'success' | 'info' | 'notice' | 'brand';
  icon?: IconName;
  children: React.ReactNode;
}) {
  const tones = {
    neutral: 'bg-sunken text-ink-soft',
    success: 'bg-success-soft text-success',
    info: 'bg-info-soft text-info',
    notice: 'bg-notice-soft text-notice',
    brand: 'bg-brand-soft text-brand',
  } as const;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm px-2 py-1 text-label-sm uppercase ${tones[tone]}`}
    >
      {icon ? <Icon name={icon} className="size-3.5" /> : null}
      {children}
    </span>
  );
}

/**
 * A section this platform does not have the data for, said plainly.
 *
 * One line, muted, never a skeleton or a placeholder chart. See the note at
 * the top of this file for the ten sections this covers.
 */
export function NotConnected({ title, what }: { title: string; what: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-sm gap-y-1 rounded-md border border-dashed border-line px-md py-sm">
      <span className="text-label-md uppercase text-ink-faint">{title}</span>
      <span className="text-body-sm text-ink-faint">{what}</span>
    </div>
  );
}

/* ------------------------------------------------------------ key specs -- */

export type SpecTile = { icon: IconName; value: string; label: string };

/**
 * The mock's key specification bar: an icon in a raised square, the figure
 * above its label, five across on a sunken strip.
 *
 * This replaced a bare `<dl>` of numbers. The difference is not decoration —
 * the tiles are what make five unlabelled integers legible at a glance, which
 * is the one thing a buyer scans a property page for.
 */
export function SpecBar({ specs }: { specs: SpecTile[] }) {
  if (specs.length === 0) return null;

  return (
    <dl
      /*
        auto-fit, not a fixed five.

        The mock always has five tiles. Here a listing may have one — bedrooms,
        bathrooms and car spaces are all nullable — and five fixed columns gave
        that one tile a fifth of the row, which was narrow enough that "322 m²"
        wrapped between the number and the unit. auto-fit gives each tile a
        floor of 8rem and still fits five across the 8-of-12 column.
      */
      className="grid gap-md rounded-xl bg-canvas p-md [grid-template-columns:repeat(auto-fit,minmax(8rem,1fr))]"
    >
      {specs.map((s) => (
        <div key={s.label} className="flex items-center gap-sm">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-card text-ink shadow-card">
            <Icon name={s.icon} className="size-5" />
          </span>
          <div className="min-w-0">
            <dd className="font-display text-headline-md text-ink">{s.value}</dd>
            <dt className="truncate text-label-sm uppercase text-ink-soft">{s.label}</dt>
          </div>
        </div>
      ))}
    </dl>
  );
}

/* ----------------------------------------------------------- inspections -- */

/**
 * The mock's inspection sessions: one row per time, the day in bold, the
 * window under it, and the kind as a pill — because "auction" and "private
 * appointment" are different commitments from "open for inspection" and a
 * visitor who mistakes one for the other turns up to a locked door.
 *
 * `listingInspections` drops past sessions in SQL, so everything here is
 * attendable. That is why there is no "past inspections" state to render.
 */
export function Inspections({ inspections }: { inspections: PublicInspection[] }) {
  if (inspections.length === 0) {
    return (
      <Card id="inspections" eyebrow="Inspections" title="No times scheduled">
        <p className="text-body-md text-ink-soft">
          Nothing is open right now. Send an enquiry and the agent can arrange a
          private appointment.
        </p>
      </Card>
    );
  }

  const tone = { open: 'success', private: 'info', auction: 'notice' } as const;
  const label = { open: 'Confirmed', private: 'By appointment', auction: 'Auction' } as const;

  return (
    <Card
      id="inspections"
      eyebrow="Upcoming inspection sessions"
      title="Open for inspection"
      note="Bring photo ID if the agency asks for it on arrival."
    >
      <ul className="m-0 grid list-none gap-sm p-0 sm:grid-cols-2">
        {inspections.map((i) => (
          <li
            key={i.id}
            className="flex items-center gap-md rounded-lg border border-line-subtle bg-canvas px-md py-sm"
          >
            <Icon name="calendar" className="size-5 text-brand" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-sm">
                <span className="text-title-sm text-ink">{WHEN.format(i.startsAt)}</span>
                <Chip tone={tone[i.kind]}>{label[i.kind]}</Chip>
              </div>
              <div className="mt-0.5 text-body-sm tabular-nums text-ink-soft">
                {TIME.format(i.startsAt)} – {TIME.format(i.endsAt)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* -------------------------------------------------------------- timeline -- */

/**
 * What has happened at this address, as the mock's transaction table.
 *
 * Date · Event · Price · Agency, which is exactly the shape `propertyTimeline`
 * returns — and the one section of the mock's "Market Performance" block this
 * platform can fill honestly. The three stat tiles beside it in the mock
 * (suburb median, rental yield, days on market) need a market data feed that
 * does not exist here, so they are not drawn.
 *
 * Every figure is `sold_price` as the agency entered it and every date is
 * `sold_date`. Nothing is estimated, modelled or compared to a median.
 *
 * It is a real <table>: four columns of the same four fields per row is
 * tabular data, and a screen reader reading "Oct 2025, Sold, $492,000, Local
 * Agency Partner" needs the column headers to make sense of the third value.
 */
/**
 * The entries worth showing.
 *
 * One entry that IS the listing being viewed tells the reader nothing they
 * cannot already see above it, so it is dropped — and then there is nothing
 * left to draw.
 *
 * `currentListingId` is optional because the off-market property page has no
 * current listing: nothing there is on the market, so every entry is history
 * and all of them are worth showing. Passing nothing keeps the whole list,
 * which is why the filter is written as a comparison against `undefined`
 * rather than a truthiness test.
 *
 * Exported because the listing page's tab bar had to make the same decision.
 * It did not: the tab was built from `timeline.length` while the section was
 * built from this filter, so a property whose only history was its own live
 * listing rendered a "History" tab that scrolled to nothing. Two places
 * deciding one thing is how that happens; this is the one place.
 */
export function usefulTimeline(
  entries: PublicTimelineEntry[],
  currentListingId?: string,
): PublicTimelineEntry[] {
  if (currentListingId === undefined) return entries;
  return entries.filter((e) => e.listingId !== currentListingId || entries.length > 1);
}

export function Timeline({
  entries,
  currentListingId,
}: {
  entries: PublicTimelineEntry[];
  /** Omitted on the off-market page, where there is no listing being viewed. */
  currentListingId?: string;
}) {
  const useful = usefulTimeline(entries, currentListingId);
  if (useful.length === 0) return null;

  return (
    <Card
      id="history"
      eyebrow="Property telemetry"
      title="Property history"
      note="Taken from the listings written against this address. Nothing here is estimated."
    >
      {/*
        A vertical timeline, not the table this used to be.

        Four columns of Date · Event · Price · Agency was tabular and honest,
        but it buried the one figure a reader came for — the sale price — in a
        third column at body size. The price is the heading of each entry now,
        with the year in the margin and a rule connecting them, which is how
        every portal that shows this data presents it and is genuinely easier
        to scan.

        Still a real list: `<ol>` because these are ordered events, newest
        first, and a screen reader should say so.
      */}
      <ol className="grid gap-0">
        {useful.map((e, i) => {
          const when = e.soldDate ?? e.publishedAt;
          const isThis = e.listingId === currentListingId;
          const isSold = e.status === 'sold';
          const last = i === useful.length - 1;
          const thumb = mediaUrl(e.mainPhotoKey);

          return (
            <li key={e.listingId} className="grid grid-cols-[3.5rem_1fr] gap-x-sm">
              {/* The year, and the dot-and-rule that makes it a timeline. */}
              <div className="grid grid-cols-[1fr_auto] items-start gap-x-2 pt-1">
                <span className="text-body-sm tabular-nums text-ink-soft">
                  {when ? when.getFullYear() : '—'}
                </span>
                <span className="grid justify-items-center self-stretch">
                  <span
                    aria-hidden
                    className={`mt-1.5 size-2 rounded-full ${isSold ? 'bg-brand' : 'bg-line'}`}
                  />
                  {/* No rule under the last entry, or the list trails into nothing. */}
                  {last ? null : <span aria-hidden className="w-px flex-1 bg-line-subtle" style={{ minHeight: '100%' }} />}
                </span>
              </div>

              <div className={`flex flex-wrap items-start justify-between gap-sm ${last ? 'pb-0' : 'pb-lg'}`}>
                <div className="grid gap-1">
                  <div className="flex flex-wrap items-center gap-sm">
                    {isSold ? (
                      <Chip tone="success">Sold</Chip>
                    ) : isThis ? (
                      <Chip tone="brand">This listing</Chip>
                    ) : (
                      <Chip>Listed</Chip>
                    )}
                    {/*
                      The figure, at heading size, because it is what the entry
                      is about. `sold_price` as the agency entered it, or the
                      display copy when there is no sale — never both, and never
                      computed from anything (#4).
                    */}
                    <span className="text-headline-sm font-display text-ink">
                      {e.soldPrice !== null ? AUD.format(e.soldPrice) : (e.priceDisplay ?? '—')}
                    </span>
                  </div>
                  <p className="text-body-sm text-ink-soft">
                    {isSold ? 'Sold' : 'Listed'}
                    {when ? ` ${DATE.format(when)}` : ''} by {e.agencyName}
                  </p>
                </div>

                {/*
                  The campaign's cover photo and how many it had.

                  Both come from the one timeline query, sub-selected — a
                  thumbnail per entry fetched separately would be the N+1 that
                  query-count.test.ts refuses. A campaign with no photos simply
                  renders no frame rather than an empty grey box.
                */}
                {thumb ? (
                  <div className="flex items-center gap-sm">
                    <img
                      src={thumb}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-14 w-20 rounded-md object-cover"
                    />
                    {e.photoCount > 0 ? (
                      <span className="text-body-sm tabular-nums text-ink-faint">
                        {e.photoCount} photo{e.photoCount === 1 ? '' : 's'}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/* ---------------------------------------------------------------- agents -- */

/**
 * The mock's listing agency panel: agency, licence line, then the people, each
 * with a tappable number.
 *
 * `tel:` is the point of this panel. On the device most property pages are
 * read on, a phone number that is not a link is a number to be copied by hand.
 *
 * The email address is deliberately absent — `listingAgentCards` does not
 * return it. A phone number on a property ad is the convention and the reason
 * the snapshot column exists; an email rendered into a public page is
 * harvested within days. The enquiry form below is the route for written
 * contact.
 */
export function AgentPanel({
  agents,
  agencyName,
  sold = false,
}: {
  agents: PublicAgentCard[];
  agencyName: string;
  /** On a sold property's page: the agency that sold it, and no enquiry form. */
  sold?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line-subtle bg-card p-lg shadow-card">
      <div className="border-b border-line-subtle pb-md">
        <div className="text-label-sm uppercase tracking-wide text-ink-faint">
          {sold ? 'Sold by' : 'Listing agency'}
        </div>
        <div className="mt-0.5 font-display text-headline-md text-ink">{agencyName}</div>
      </div>

      {agents.length === 0 ? (
        <p className="pt-md text-body-sm text-ink-soft">
          {sold
            ? 'Contact details for this agency are not published. Use the offer form below.'
            : 'Contact details for this listing are not published. Use the enquiry form below.'}
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-md p-0 pt-md">
          {agents.map((a) => (
            <li key={`${a.name}-${a.phone}`} className="flex items-start gap-sm">
              {/*
                An uploaded portrait beats a pasted link.

                `photoKey` is a file this platform holds, in the one bucket
                next.config allows, so it goes through next/image and is
                resized to the 44px it is drawn at. `photoUrl` is whatever URL
                an agency typed into the console at some point — an arbitrary
                remote host that next/image would refuse, so it stays a plain
                <img>. Both are already gated on agent_profile.public by
                listingAgentCards; neither is a decision made here.
              */}
              {mediaUrl(a.photoKey) ? (
                <Image
                  src={mediaUrl(a.photoKey) as string}
                  alt=""
                  width={44}
                  height={44}
                  className="size-11 shrink-0 rounded-full border border-line-subtle object-cover"
                />
              ) : a.photoUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element -- see above */
                <img
                  src={a.photoUrl}
                  alt=""
                  width={44}
                  height={44}
                  className="size-11 shrink-0 rounded-full border border-line-subtle object-cover"
                />
              ) : (
                <span
                  aria-hidden
                  className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-title-sm uppercase text-brand"
                >
                  {a.name
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => part[0] ?? '')
                    .join('')}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-title-sm text-ink">{a.name}</div>
                <div className="text-body-sm text-ink-soft">
                  {a.role === 'lead' ? 'Lead agent' : a.role === 'co' ? 'Co-agent' : 'Property manager'}
                  {a.licenceNumber ? ` · Licence ${a.licenceNumber}` : ''}
                </div>
                {a.phone ? (
                  <a
                    href={`tel:${a.phone.replace(/\s+/g, '')}`}
                    className="mt-1 inline-flex items-center gap-1.5 text-body-sm text-brand hover:underline"
                  >
                    <Icon name="phone" className="size-3.5" />
                    {a.phone}
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------- due diligence -- */

/**
 * Victoria's due diligence checklist, and only Victoria's.
 *
 * The mock carries this block because its listing is in Pakenham. It is a real
 * obligation under section 33A of the Sale of Land Act 1962, not portal
 * furniture — but it is a *Victorian* one, so rendering it on a NSW listing
 * would be stating a legal requirement that does not apply there.
 *
 * The wording stays general and links to the official page rather than
 * paraphrasing the Act. This platform is not the authority on it and should
 * not read as though it is.
 */
export function DueDiligence({ state }: { state: string }) {
  if (state.toUpperCase() !== 'VIC') return null;

  return (
    <aside className="rounded-xl border border-line-subtle border-l-4 border-l-info bg-card p-lg shadow-card">
      <div className="flex items-start gap-md">
        <Icon name="doc" className="mt-0.5 size-5 text-info" />
        <div>
          <h2 className="text-title-sm text-ink">Due diligence checklist</h2>
          <p className="mt-1 text-body-sm text-ink-soft">
            Consumer Affairs Victoria publishes a due diligence checklist for
            buyers of residential property. Victorian vendors and their agents
            must make it available before a property is offered for sale.
          </p>
          <a
            className="mt-sm inline-flex items-center gap-1.5 text-body-sm text-info hover:underline"
            href="https://www.consumer.vic.gov.au/duediligencechecklist"
            target="_blank"
            rel="noopener noreferrer"
          >
            Read the official checklist
          </a>
        </div>
      </div>
    </aside>
  );
}
