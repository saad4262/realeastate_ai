import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Actor } from '@repo/core/permissions';
import { getListingForEdit } from '@repo/core/listings';
import { MAX_LISTING_PHOTOS, listingPhotos } from '@repo/core/media';
import { BuyerMatchError, listingBuyers, matchingBuyerCounts } from '@repo/core/buyer-matching';
import { listingFieldsUsed, listingSnapshotFor, listTemplates, mergeValuesFor, SKIP_REASON_LABELS } from '@repo/core/template-email';
import { holderOf, isSkillOn, skillOffMessage } from '@repo/core/skill-switches';
import contactStyles from '@/components/contacts/contacts.module.css';
import { ListingForm } from '@/components/listing-form';
import { ListingPhotosSkeleton } from '@/components/listing-form-skeleton';
import { ListingPhotos } from '@/components/photo-uploader';
import { ListingDocuments } from '@/components/documents/listing-documents';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { BuyerPicker } from './buyer-picker';
import { DealTab } from '@/components/deals/deal-tab';
import styles from './matching-buyers.module.css';

export const LISTING_TABS = ['details', 'photos', 'documents', 'buyers', 'deal'] as const;
export type ListingTab = (typeof LISTING_TABS)[number];
const TAB_LABELS: Record<ListingTab, string> = { details: 'Details', photos: 'Photos', documents: 'Documents', buyers: 'Matching buyers', deal: 'Deal' };

export function parseListingTab(raw: unknown): ListingTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (LISTING_TABS as readonly string[]).includes(v as string) ? (v as ListingTab) : 'details';
}

/**
 * A listing's page, in tabs (ADR 0060, the user's decision 1): Details (the form), Photos, Documents
 * (ADR 0053), Matching buyers and Deal (ADR 0063). Shared by the agency's `/live-listings/[id]/edit` and the agent's
 * `/listings/[id]/edit`; the tab is in the URL. Offers and more fit in later.
 */
export async function ListingPage({ surface, id, tab }: { surface: 'agency' | 'agent'; id: string; tab: ListingTab }) {
  const session = await requireConsoleAccess(surface);
  const db = getConsoleDb();
  // Agency-scoped inside getListingForEdit, so another agency's id is a 404 here rather than a
  // permission error that confirms the listing exists. Every panel below renders only after it.
  const listing = await getListingForEdit(db, session.actor, id);
  if (!listing) notFound();
  const base = surface === 'agency' ? '/live-listings' : '/listings';
  const href = (t: ListingTab) => (t === 'details' ? `${base}/${id}/edit` : `${base}/${id}/edit?tab=${t}`);
  // One statement: the same count the Listings table shows.
  const count = (await matchingBuyerCounts(db, session.actor, [id]).catch(() => ({}) as Record<string, number>))[id] ?? 0;

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: '0.75rem' }}>
        <div>
          <h1 style={{ margin: 0, fontFamily: 'var(--font-display, inherit)', fontSize: '1.5rem', letterSpacing: '-0.02em' }}>Edit listing</h1>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>{listing.address}</p>
        </div>
        {/* ADR 0065: everything the agency has on the address — owners, enquiries, appraisals, the deal. */}
        <Link href={`${surface === 'agency' ? '/properties' : '/my-properties'}/${listing.propertyId}`} className={contactStyles.btnGhost}>
          Property page
        </Link>
      </div>

      <nav className={contactStyles.tabs} aria-label="Listing sections">
        {LISTING_TABS.map((t) => (
          <Link key={t} href={href(t)} className={`${contactStyles.tab} ${tab === t ? contactStyles.tabOn : ''}`} aria-current={tab === t ? 'page' : undefined}>
            {TAB_LABELS[t]}
            {t === 'buyers' && count ? <span className={styles.tabCount}>{count}</span> : null}
          </Link>
        ))}
      </nav>

      {tab === 'details' ? <ListingForm backHref={base} initial={listing} /> : null}
      {tab === 'photos' ? (
        <Suspense fallback={<ListingPhotosSkeleton />}>
          <Photos listingId={id} />
        </Suspense>
      ) : null}
      {tab === 'documents' ? (
        <Suspense fallback={null}>
          <ListingDocuments listingId={id} userId={session.actor.userId} />
        </Suspense>
      ) : null}
      {tab === 'deal' ? (
        <Suspense fallback={<p className={styles.empty}>Loading the deal…</p>}>
          <DealTab actor={session.actor} listingId={id} surface={surface} />
        </Suspense>
      ) : null}
      {tab === 'buyers' ? (
        <Suspense fallback={<p className={styles.empty}>Finding buyers whose brief fits…</p>}>
          <MatchingBuyers actor={session.actor} surface={surface} listingId={id} live={listing.status === 'live'} />
        </Suspense>
      ) : null}
    </div>
  );
}

async function Photos({ listingId }: { listingId: string }) {
  const photos = await listingPhotos(getConsoleDb(), listingId);
  return <ListingPhotos listingId={listingId} photos={photos} max={MAX_LISTING_PHOTOS} />;
}

/** The Matching buyers tab: who fits, who may be emailed, and the island that emails or lists them for a call. */
async function MatchingBuyers({ actor, surface, listingId, live }: { actor: Actor; surface: 'agency' | 'agent'; listingId: string; live: boolean }) {
  const db = getConsoleDb();
  let found;
  try {
    found = await listingBuyers(db, actor, listingId);
  } catch (err) {
    if (err instanceof BuyerMatchError) return <p role="alert" className={styles.error}>{err.message}</p>;
    throw err;
  }
  const [templates, mergeFor, listingValues, bulkEmailOn] = await Promise.all([
    listTemplates(db, actor).then((r) => r.templates.filter((t) => t.mayUse)).catch(() => []),
    mergeValuesFor(db, { agencyId: actor.agencyId as string, userId: actor.userId }),
    listingSnapshotFor(db, actor, listingId, []),
    isSkillOn(db, actor, 'bulk_email'),
  ]);
  const names = mergeFor('');
  const owner = surface === 'agency';

  return (
    <>
      <p className={styles.searched}>
        <span className={styles.glyph} aria-hidden>manage_search</span>
        <span>
          Buyers whose brief fits this listing: <b>{found.searched}</b>. A brief fits when the price ranges overlap, it needs no more
          bedrooms or bathrooms than this has, and the suburb and type are among its own — a brief that names none accepts any.{' '}
          {owner ? 'Showing every buyer in the agency.' : 'Showing only buyers you may see.'}
        </span>
      </p>
      <BuyerPicker
        listingId={listingId}
        contactBase={owner ? '/customers' : '/my-contacts'}
        batchBase={owner ? '/bulk-email' : '/my-bulk-email'}
        templatesHref={owner ? '/bulk-email/templates/new' : '/my-bulk-email/templates/new'}
        buyers={found.buyers.map((b) => ({
          contactId: b.contactId,
          name: b.name,
          brief: b.brief,
          assigneeName: b.assigneeName,
          enquired: b.enquired,
          skipReason: b.skipReason,
          skipLabel: b.skipReason ? SKIP_REASON_LABELS[b.skipReason] : null,
        }))}
        templates={templates.map((t) => ({ id: t.id, name: t.name, subject: t.subject, body: t.body, usesLink: listingFieldsUsed(t.subject, t.body).includes('listing_link') }))}
        merge={{
          agent_name: names.agent_name,
          agency_name: names.agency_name,
          listing_address: listingValues.listing_address,
          listing_price: listingValues.listing_price,
          listing_link: listingValues.listing_link,
        }}
        listingLive={live}
        bulkEmailOn={bulkEmailOn}
        bulkEmailOffMessage={skillOffMessage('bulk_email', holderOf(actor.membershipRole))}
      />
      <p className={styles.note}>
        <span className={styles.glyph} aria-hidden>info</span>
        <span>
          Email follows the bulk-email rules: someone is emailed only if they agreed to marketing, enquired in the last 24 months, or are a
          client; anyone unsubscribed, archived or without an email is shown with why, and can’t be picked. Up to 20 people per batch; nothing
          is sent until you press Approve &amp; Send on the next screen. “Remind me to call” makes one reminder at 9 am tomorrow with every
          buyer’s name and phone.
          {bulkEmailOn ? '' : ` ${skillOffMessage('bulk_email', holderOf(actor.membershipRole))}`}
        </span>
      </p>
    </>
  );
}
