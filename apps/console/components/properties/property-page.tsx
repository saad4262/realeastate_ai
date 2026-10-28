import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DEAL_STAGES, DEAL_STAGE_LABELS, stageIndex } from '@repo/core/deals/stages';
import { getPropertyView, listingStatusWords, PropertyError, type PropertyEvent, type PropertyView, type RecordTab } from '@repo/core/properties';
import { holderOf, isSkillOn, skillOffMessage } from '@repo/core/skill-switches';
import { mediaUrl } from '@repo/core/media';
import contactStyles from '@/components/contacts/contacts.module.css';
import dealStyles from '@/components/deals/deals.module.css';
import { getConsoleDb } from '../../lib/db';
import { loadListingActor } from '../../lib/load-actor';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { PropertySummary } from './property-summary';
import styles from './properties.module.css';

export const PROPERTY_TABS = ['overview', 'people', 'enquiries', 'visits', 'documents', 'history'] as const satisfies readonly RecordTab[];
const TAB_LABELS: Record<RecordTab, string> = { overview: 'Overview', people: 'People', enquiries: 'Enquiries & offers', visits: 'Appraisals & visits', documents: 'Documents', history: 'History' };

export function parsePropertyTab(raw: unknown): RecordTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (PROPERTY_TABS as readonly string[]).includes(v as string) ? (v as RecordTab) : 'overview';
}

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const money = (n: number | null) => (n === null ? '—' : AUD.format(n));
const isoDay = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)) : '—');
const KIND_WORDS = { offer: 'Offer', enquiry: 'Enquiry', inspection: 'Inspection', appraisal: 'Appraisal' } as const;
const EVENT_ICONS: Record<PropertyEvent['kind'], { icon: string; tone?: string }> = {
  offer: { icon: 'request_quote', tone: styles.icoOffer },
  enquiry: { icon: 'mail', tone: styles.icoEnquiry },
  inspection: { icon: 'door_open', tone: styles.icoEnquiry },
  appraisal: { icon: 'real_estate_agent', tone: styles.icoAppraisal },
  appointment: { icon: 'event' },
  open_home: { icon: 'groups' },
  deal: { icon: 'swap_horiz' },
  listed: { icon: 'rocket_launch', tone: styles.icoSold },
  sold: { icon: 'sell', tone: styles.icoSold },
  document: { icon: 'description' },
  linked: { icon: 'link' },
};
const initials = (name: string) => name.trim().split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';

/**
 * One property with everything on it (ADR 0065, docs/mocks/property-page.html). Shared by the agency's
 * `/properties/[id]` and the agent's `/my-properties/[id]`; the tab is in the URL. Every record arrives
 * through its own visibility rule in core; an address this person is not tied to is a 404. A read only —
 * changes are made on the listing, the contact or the Deal tab.
 */
export async function PropertyPage({ surface, id, tab }: { surface: 'agency' | 'agent'; id: string; tab: RecordTab }) {
  const session = await requireConsoleAccess(surface);
  // With the listings they are named on: `listing:edit` decides the "Open the listing" button.
  const actor = (await loadListingActor(session.actor.userId)) ?? session.actor;
  const db = getConsoleDb();
  let v: PropertyView | null;
  try {
    v = await getPropertyView(db, actor, id);
  } catch (err) {
    return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{err instanceof PropertyError ? err.message : 'Could not load the property'}</p>;
  }
  if (!v) notFound();
  const view = v;
  const summaryOn = await isSkillOn(db, actor, 'property_summaries').catch(() => true);

  const base = `${surface === 'agency' ? '/properties' : '/my-properties'}/${id}`;
  const listingBase = surface === 'agency' ? '/live-listings' : '/listings';
  const contactBase = surface === 'agency' ? '/customers' : '/my-contacts';
  const webUrl = process.env.NEXT_PUBLIC_WEB_URL ?? 'http://web.lvh.me:3000';
  const href = (t: RecordTab) => (t === 'overview' ? base : `${base}?tab=${t}`);
  const at = (d: Date, withYear = false) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: view.timeZone });
  const atTime = (d: Date, timeZone: string) =>
    d.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone });

  const f = view.facts;
  const cur = view.current;
  const photo = mediaUrl(cur?.photoKey);
  const counts: Partial<Record<RecordTab, number>> = {
    people: view.people.length,
    enquiries: view.leads.length,
    visits: view.appointments.length + view.inspections.length,
    documents: view.documents.length,
    history: view.listings.length,
  };
  const facts = [
    f.propertyType ? { icon: 'home', text: f.propertyType[0]!.toUpperCase() + f.propertyType.slice(1) } : null,
    f.bedrooms !== null ? { icon: 'bed', text: `${f.bedrooms}` } : null,
    f.bathrooms !== null ? { icon: 'bathtub', text: `${f.bathrooms}` } : null,
    f.carSpaces !== null ? { icon: 'directions_car', text: `${f.carSpaces}` } : null,
    f.landAreaSqm !== null ? { icon: 'square_foot', text: `${f.landAreaSqm} m² land` } : null,
    f.yearBuilt !== null ? { icon: 'calendar_month', text: `Built ${f.yearBuilt}` } : null,
  ].filter((x): x is { icon: string; text: string } => Boolean(x));

  return (
    <div className={contactStyles.wrap}>
      <p className={styles.crumb}>
        <Link href={surface === 'agency' ? '/properties' : '/my-properties'}>Properties</Link> / {f.address}
      </p>
      <div className={styles.hero}>
        {/* eslint-disable-next-line @next/next/no-img-element -- console thumbnails are not on next/image (photo-uploader.tsx). */}
        {photo ? <img src={photo} alt="" className={styles.photo} /> : <div className={`${styles.photo} ${styles.noPhoto}`}><span className={dealStyles.glyph} aria-hidden>image</span></div>}
        <div>
          <h1 className={styles.address}>{f.address} {f.state} {f.postcode}</h1>
          {facts.length ? (
            <div className={styles.facts}>
              {facts.map((x) => (
                <span key={x.icon}><span className={dealStyles.glyph} aria-hidden>{x.icon}</span>{x.text}</span>
              ))}
            </div>
          ) : null}
          <div className={styles.pills}>
            {view.deal ? (
              <span className={`${dealStyles.pill} ${dealStyles.pillAuto}`}>
                <span className={dealStyles.glyph} aria-hidden>view_kanban</span>
                Deal · {view.deal.status === 'open' ? DEAL_STAGE_LABELS[view.deal.stage] : view.deal.status === 'settled' ? 'Settled' : 'Withdrawn'}
              </span>
            ) : null}
            {cur ? <span className={`${dealStyles.pill} ${cur.status === 'under_offer' ? dealStyles.pillWarn : ''}`}>Listing · {listingStatusWords(cur.status)}</span> : null}
            {cur?.agentName ? <span className={dealStyles.pill}>Lead agent · {cur.agentName}</span> : null}
          </div>
        </div>
        <div className={styles.heroActions}>
          {cur?.mayEdit ? (
            <Link href={`${listingBase}/${cur.id}/edit`} className={`${dealStyles.btn} ${dealStyles.btnPrimary}`}>
              <span className={dealStyles.glyph} aria-hidden>edit</span>Open the listing
            </Link>
          ) : null}
          <a href={`${webUrl}/property/${f.id}`} target="_blank" rel="noopener" className={dealStyles.btn}>
            <span className={dealStyles.glyph} aria-hidden>open_in_new</span>Public page
          </a>
        </div>
      </div>

      <nav className={contactStyles.tabs} aria-label="Property sections">
        {PROPERTY_TABS.map((t) => (
          <Link key={t} href={href(t)} className={`${contactStyles.tab} ${tab === t ? contactStyles.tabOn : ''}`} aria-current={tab === t ? 'page' : undefined}>
            {TAB_LABELS[t]}
            {counts[t] ? <span className={styles.tabCount}>{counts[t]}</span> : null}
          </Link>
        ))}
      </nav>

      {tab === 'overview' ? <Overview /> : null}
      {tab === 'people' ? <People /> : null}
      {tab === 'enquiries' ? <Enquiries /> : null}
      {tab === 'visits' ? <Visits /> : null}
      {tab === 'documents' ? <Documents /> : null}
      {tab === 'history' ? <History /> : null}
    </div>
  );

  function Overview() {
    const recent = view.timeline.slice(0, 12);
    const older = view.timeline.slice(12, 80);
    return (
      <div className={styles.grid}>
        <div className={styles.stack}>
          <PropertySummary propertyId={f.id} base={base} on={summaryOn} offMessage={summaryOn ? null : skillOffMessage('property_summaries', holderOf(actor.membershipRole))} />
          <section className={dealStyles.panel} aria-labelledby="happened">
            <div className={dealStyles.panelHead}>
              <h3 id="happened">What has happened</h3>
              <span className={dealStyles.muted}>newest first</span>
            </div>
            {recent.length ? <Timeline items={recent} /> : <p className={dealStyles.muted} style={{ margin: 0 }}>Nothing on record here yet.</p>}
            {older.length ? (
              <details className={styles.more}>
                <summary>Show older ({older.length})</summary>
                <Timeline items={older} />
              </details>
            ) : null}
          </section>
        </div>
        <div className={styles.stack}>
          <PipelinePanel />
          <section className={dealStyles.panel} aria-labelledby="ov-people">
            <div className={dealStyles.panelHead}>
              <h3 id="ov-people">People</h3>
              {view.people.length > 5 ? <Link href={href('people')} className={dealStyles.btnLink}>All {view.people.length}</Link> : null}
            </div>
            <PeopleList limit={5} />
          </section>
          <section className={dealStyles.panel} aria-labelledby="ov-docs">
            <div className={dealStyles.panelHead}>
              <h3 id="ov-docs">Documents</h3>
              {view.documents.length > 4 ? <Link href={href('documents')} className={dealStyles.btnLink}>All {view.documents.length}</Link> : null}
            </div>
            {view.documents.length ? (
              <ul className={styles.list}>
                {view.documents.slice(0, 4).map((d) => (
                  <li key={d.id}>
                    <span className={styles.av}><span className={dealStyles.glyph} aria-hidden>description</span></span>
                    <span>
                      <a href={`/api/documents/${d.id}`} target="_blank" rel="noopener">{d.title}</a>
                      <span className={dealStyles.muted} style={{ display: 'block' }}>{onWords(d.on, d.contactName)} · {at(d.createdAt)}</span>
                    </span>
                    {d.isPrivate ? <span className={dealStyles.pill}>Private</span> : <span className={dealStyles.pill}>{d.kind}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={dealStyles.muted} style={{ margin: 0 }}>None yet. Add them on the listing’s Documents tab or the owner’s contact.</p>
            )}
          </section>
        </div>
      </div>
    );
  }

  function PipelinePanel() {
    const d = view.deal;
    const now = d ? stageIndex(d.stage) : -1;
    return (
      <section className={dealStyles.panel} aria-labelledby="ov-deal">
        <div className={dealStyles.panelHead}>
          <h3 id="ov-deal">Pipeline</h3>
          {d?.listingId && cur?.mayEdit ? <Link href={`${listingBase}/${d.listingId}/edit?tab=deal`} className={dealStyles.btnLink}>Open Deal tab</Link> : null}
        </div>
        {d ? (
          <>
            <div className={dealStyles.stepper} aria-label={`Stage: ${DEAL_STAGE_LABELS[d.stage]}`}>
              {DEAL_STAGES.map((s, i) => (
                <div key={s} className={`${dealStyles.step} ${d.status === 'settled' || i < now ? dealStyles.stepDone : i === now ? dealStyles.stepNow : ''}`} aria-current={i === now ? 'step' : undefined}>
                  <i />
                  {DEAL_STAGE_LABELS[s]}
                </div>
              ))}
            </div>
            <dl className={dealStyles.dl} style={{ marginTop: '0.75rem' }}>
              {cur ? <><dt>Asking</dt><dd>{cur.priceText}</dd></> : null}
              {view.offers ? <><dt>Offers</dt><dd>{view.offers.count ? `${view.offers.count} · highest ${money(view.offers.highest)}` : 'None yet'}</dd></> : null}
              {d.salePrice !== null ? <><dt>Sale price</dt><dd>{money(d.salePrice)}</dd></> : null}
              {d.settlementDate ? <><dt>Settlement</dt><dd>{isoDay(d.settlementDate)}</dd></> : null}
              {cur?.daysOnMarket !== null && cur?.daysOnMarket !== undefined ? <><dt>Days on market</dt><dd>{cur.daysOnMarket}</dd></> : null}
              {d.commissionSet !== null ? <><dt>Commission</dt><dd>{d.commissionSet ? 'Set' : 'Not set yet'}</dd></> : null}
            </dl>
          </>
        ) : (
          <p className={dealStyles.muted} style={{ margin: 0 }}>No deal at this address. One opens by itself with an appraisal or a sale listing (ADR 0063).</p>
        )}
      </section>
    );
  }

  function PeopleList({ limit }: { limit: number }) {
    if (!view.people.length) return <p className={dealStyles.muted} style={{ margin: 0 }}>Nobody linked yet. Link an owner from their contact’s Properties tab.</p>;
    return (
      <ul className={styles.list}>
        {view.people.slice(0, limit).map((p) => (
          <li key={p.contactId}>
            <span className={styles.av}>{initials(p.name)}</span>
            <span>
              <Link href={`${contactBase}/${p.contactId}`}>{p.name}</Link>
              <span className={dealStyles.muted} style={{ display: 'block' }}>{p.roles.join(' · ')}</span>
            </span>
            <span className={`${dealStyles.pill} ${p.roles.some((r) => ['Owner', 'Vendor', 'Landlord'].includes(r)) ? dealStyles.pillOk : p.roles.includes('Made an offer') ? dealStyles.pillWarn : ''}`}>{p.roles[0]}</span>
          </li>
        ))}
      </ul>
    );
  }

  function People() {
    return (
      <>
        <Table head={['Person', 'To this property', 'Where it comes from', 'Phone / email']} empty={view.people.length === 0} cols={4}>
          {view.people.map((p) => (
            <tr key={p.contactId}>
              <td><Link href={`${contactBase}/${p.contactId}`}>{p.name}</Link></td>
              <td><span style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>{p.roles.map((r) => <span key={r} className={dealStyles.pill}>{r}</span>)}</span></td>
              <td className={dealStyles.muted}>{p.sources.join(' · ')}</td>
              <td>{[p.phone, p.email].filter(Boolean).join(' · ') || '—'}</td>
            </tr>
          ))}
        </Table>
        <Note icon="info">
          Owners, vendors, landlords and tenants come from the contact’s <b>Properties</b> link and the deal; anyone who enquired{view.maySeeOffers ? ' or made an offer' : ''} comes from
          their enquiry. A person you may not open is not listed.
        </Note>
      </>
    );
  }

  function Enquiries() {
    return (
      <>
        <Table head={['When', 'Who', 'Kind', 'Message', ...(view.maySeeOffers ? ['Offer'] : []), 'Status']} num={view.maySeeOffers ? [4] : []} empty={view.leads.length === 0} cols={view.maySeeOffers ? 6 : 5}>
          {view.leads.map((l) => (
            <tr key={l.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{at(l.createdAt, true)}</td>
              <td>{l.contactId ? <Link href={`${contactBase}/${l.contactId}`}>{l.name}</Link> : l.name}</td>
              <td><span className={`${dealStyles.pill} ${l.kind === 'offer' ? dealStyles.pillWarn : l.kind === 'enquiry' ? dealStyles.pillAuto : ''}`}>{KIND_WORDS[l.kind]}</span></td>
              <td className={dealStyles.muted}>{l.message ? (l.message.length > 140 ? `${l.message.slice(0, 140)}…` : l.message) : '—'}</td>
              {view.maySeeOffers ? <td className={dealStyles.num}>{l.kind === 'offer' ? money(l.offerAmount) : '—'}</td> : null}
              <td style={{ textTransform: 'capitalize' }}>{l.status}</td>
            </tr>
          ))}
        </Table>
        {view.scope === 'own' ? (
          <Note icon="lock">You see the enquiries on listings you are named on and the ones assigned to you — the same as your Leads page. Private offers stay with owners and admins, as they do everywhere else.</Note>
        ) : null}
      </>
    );
  }

  function Visits() {
    return (
      <>
        <Table head={['When', 'What', 'With', 'Agent', 'Outcome']} empty={view.appointments.length === 0} cols={5}>
          {view.appointments.map((a) => (
            <tr key={a.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{atTime(a.startsAt, a.timezone)}</td>
              <td><span className={`${dealStyles.pill} ${a.type === 'appraisal' ? dealStyles.pillAuto : ''}`}>{a.typeLabel}</span> <span className={dealStyles.muted}>{a.title}</span></td>
              <td>{a.contactName ?? '—'}</td>
              <td>{a.agentName ?? '—'}</td>
              <td className={dealStyles.muted}>{a.outcome ?? (a.status === 'cancelled' ? 'Cancelled' : a.startsAt > new Date() ? 'Booked' : a.status === 'completed' ? 'Done' : '—')}</td>
            </tr>
          ))}
        </Table>
        {view.inspections.length ? (
          <section className={dealStyles.panel} aria-labelledby="open-homes">
            <div className={dealStyles.panelHead}><h3 id="open-homes">Open homes and auctions</h3><span className={dealStyles.muted}>{view.inspections.length}</span></div>
            <ul className={styles.list}>
              {view.inspections.map((i) => (
                <li key={i.id}>
                  <span className={styles.av}><span className={dealStyles.glyph} aria-hidden>{i.kind === 'auction' ? 'gavel' : 'groups'}</span></span>
                  <span>{i.kind === 'auction' ? 'Auction' : i.kind === 'private' ? 'Private inspection' : 'Open home'}</span>
                  <span className={styles.when}>{atTime(i.startsAt, view.timeZone)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </>
    );
  }

  function Documents() {
    return (
      <>
        <Table head={['Document', 'Kind', 'On', 'Added']} empty={view.documents.length === 0} cols={4}>
          {view.documents.map((d) => (
            <tr key={d.id}>
              <td><a href={`/api/documents/${d.id}`} target="_blank" rel="noopener">{d.title}</a>{d.isPrivate ? <> <span className={dealStyles.pill}>Private</span></> : null}</td>
              <td style={{ textTransform: 'capitalize' }}>{d.kind}</td>
              <td>{onWords(d.on, d.contactName)}</td>
              <td>{at(d.createdAt, true)}{d.uploader ? ` · ${d.uploader}` : ''}</td>
            </tr>
          ))}
        </Table>
        <Note icon="info">Documents on this address’s listings and on its owners’ records. Uploading stays where it is today — the listing’s Documents tab or the contact.</Note>
      </>
    );
  }

  function History() {
    return (
      <>
        <Table head={['Campaign', 'Channel', 'Status', 'Price', 'Agent']} num={[3]} empty={view.listings.length === 0} cols={5}>
          {view.listings.map((l) => (
            <tr key={l.id}>
              <td>
                {l.mayEdit ? <Link href={`${listingBase}/${l.id}/edit`}>{campaignWords(l.publishedAt, l.soldDate, l.status, l.createdAt)}</Link> : campaignWords(l.publishedAt, l.soldDate, l.status, l.createdAt)}
              </td>
              <td>{l.channel === 'rent' || l.channel === 'leased' ? 'Rent' : 'Sale'}</td>
              <td><span className={`${dealStyles.pill} ${l.status === 'sold' ? dealStyles.pillOk : l.status === 'under_offer' ? dealStyles.pillWarn : ''}`}>{l.status === 'sold' && l.soldDate ? `Sold ${isoDay(l.soldDate)}` : listingStatusWords(l.status)}</span></td>
              <td className={dealStyles.num}>{l.status === 'sold' && l.soldPrice !== null ? money(l.soldPrice) : l.priceText}</td>
              <td>{l.agentName ?? '—'}</td>
            </tr>
          ))}
        </Table>
        <Note icon="info">Our agency’s campaigns at this address. Prices are what was entered on each listing — nothing is estimated.</Note>
      </>
    );
  }

  function campaignWords(published: Date | null, soldDate: string | null, status: string, created: Date): string {
    const from = published ? at(published, true) : `Drafted ${at(created, true)}`;
    if (status === 'sold' && soldDate) return `${from} – ${isoDay(soldDate)}`;
    return status === 'live' || status === 'under_offer' ? `${from} – now` : from;
  }

  function Timeline({ items }: { items: PropertyEvent[] }) {
    return (
      <ul className={styles.tl}>
        {items.map((e, i) => (
          <li key={`${e.kind}-${e.at.getTime()}-${i}`}>
            <span className={`${styles.ico} ${EVENT_ICONS[e.kind].tone ?? ''}`}><span className={dealStyles.glyph} aria-hidden>{EVENT_ICONS[e.kind].icon}</span></span>
            <div>
              <b>{e.title}</b>
              {e.who ? <span className={dealStyles.muted}> {e.who}</span> : null}
              {e.detail ? <p>{e.detail}</p> : null}
            </div>
            <span className={styles.when}>{at(e.at, e.at.getFullYear() !== new Date().getFullYear())}</span>
          </li>
        ))}
      </ul>
    );
  }
}

function onWords(on: 'listing' | 'contact' | 'property', contactName: string | null): string {
  return on === 'listing' ? 'The listing' : on === 'contact' ? contactName ?? 'A contact' : 'The property';
}

function Table({ head, children, empty, cols, num = [] }: { head: string[]; children: React.ReactNode; empty: boolean; cols: number; num?: number[] }) {
  return (
    <section className={dealStyles.panel} style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table className={dealStyles.finTable}>
          <thead>
            <tr>{head.map((h, i) => <th key={h} className={num.includes(i) ? dealStyles.num : undefined}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {empty ? <tr><td colSpan={cols} className={dealStyles.muted}>Nothing on record here yet.</td></tr> : children}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Note({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <p className={dealStyles.note}>
      <span className={dealStyles.glyph} aria-hidden>{icon}</span>
      <span>{children}</span>
    </p>
  );
}
