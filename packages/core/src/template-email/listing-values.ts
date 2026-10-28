import { and, eq } from 'drizzle-orm';
import { listing, property, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { formatAddress } from '../listings/listing-schema';
import { TemplateEmailError } from './templates';
import { LISTING_MERGE_FIELDS, type ListingMergeField, type ListingMergeValues } from './schema';

/**
 * A listing's merge values (ADR 0060), read once at Prepare and frozen into the batch, so what the agent
 * reviewed is what is sent. From SQL only; the link is the public ad, which only a live listing has.
 */
export type ListingSnapshot = ListingMergeValues & { listingId: string };

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

/** The price as the public site words it. Pure. */
export function listingPriceWords(l: { channel: string; priceDisplay: string | null; priceFrom: number | null; priceTo: number | null; rentPw: number | null }): string {
  if (l.channel === 'rent' || l.channel === 'leased') return l.rentPw ? `${AUD.format(l.rentPw)} per week` : 'Contact agent';
  if (l.priceDisplay) return l.priceDisplay;
  if (l.priceFrom && l.priceTo) return `${AUD.format(l.priceFrom)} – ${AUD.format(l.priceTo)}`;
  if (l.priceFrom) return AUD.format(l.priceFrom);
  return 'Contact agent';
}

export async function listingSnapshotFor(
  db: DbOrTx,
  actor: Actor,
  listingId: string,
  uses: readonly ListingMergeField[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ListingSnapshot> {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(listingId) || !can(actor, 'listing:read', { type: 'listing', id: listingId, agencyId: actor.agencyId })) {
    throw new TemplateEmailError('not_found', 'That listing was not found');
  }
  const [l] = await db
    .select({
      status: listing.status,
      channel: listing.channel,
      priceDisplay: listing.priceDisplay,
      priceFrom: listing.priceFrom,
      priceTo: listing.priceTo,
      rentPw: listing.rentPw,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
    })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(and(eq(listing.id, listingId), eq(listing.agencyId, actor.agencyId)))
    .limit(1);
  if (!l) throw new TemplateEmailError('not_found', 'That listing was not found');
  if (uses.includes('listing_link') && l.status !== 'live') {
    throw new TemplateEmailError('invalid', 'This template links to the listing’s public ad, and the listing is not live yet. Use a template without {{listing_link}}, or send it once the listing is live.');
  }
  const n = (v: string | number | null) => (v === null ? null : Number(v));
  const web = env.NEXT_PUBLIC_WEB_URL?.trim() || 'http://web.lvh.me:3000';
  return {
    listingId,
    listing_address: formatAddress(l),
    listing_price: listingPriceWords({ channel: l.channel, priceDisplay: l.priceDisplay, priceFrom: n(l.priceFrom), priceTo: n(l.priceTo), rentPw: n(l.rentPw) }),
    listing_link: `${web.replace(/\/+$/, '')}/listing/${listingId}`,
  };
}

/** The merge values a stored snapshot gives, or none. */
export function listingValuesOf(snapshot: unknown): Partial<ListingMergeValues> {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const s = snapshot as Record<string, unknown>;
  return Object.fromEntries(LISTING_MERGE_FIELDS.filter((f) => typeof s[f] === 'string').map((f) => [f, s[f] as string]));
}
