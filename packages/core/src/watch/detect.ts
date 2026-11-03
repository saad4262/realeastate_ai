import { shortlistState, type ShortlistState } from '../shortlist/shortlist';

/**
 * What changed at a watched address since the buyer last heard (ADR 0080, C4 Property Monitor). Pure: the state
 * last reported (`seen`) against the address's latest campaign now. A listing's status has no timestamp of its own,
 * so the change IS the difference between two checks. Price changes come from `listing_price_change` instead.
 *
 * Decision 3: a campaign that stops being public reads "No longer advertised on this site" — never "withdrawn",
 * never why. Every figure in a line comes from SQL (#4).
 */

export type WatchStanding = 'none' | ShortlistState;
export type WatchEventKind = 'listed' | 'price_changed' | 'under_offer' | 'sold' | 'leased' | 'not_advertised' | 'back_on_market';

/** The address's latest campaign, as read for a check. */
export type CurrentCampaign = {
  listingId: string;
  status: string;
  channel: string;
  isPublic: boolean;
  /** The price as the buyer reads it (`priceText`), already formatted. */
  price: string;
  soldPrice: number | null;
};

export function standingOf(c: CurrentCampaign | null): WatchStanding {
  return c ? shortlistState(c.status, c.channel, c.isPublic) : 'none';
}

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

function soldLine(c: CurrentCampaign): string {
  return c.soldPrice === null ? 'Sold — price not disclosed.' : `Sold for ${AUD.format(c.soldPrice)}.`;
}

export function watchEvents(seen: { listingId: string | null; status: WatchStanding }, now: CurrentCampaign | null): { kind: WatchEventKind; text: string; listingId: string | null }[] {
  if (!now) return [];
  const standing = standingOf(now);
  const advertised = (s: WatchStanding) => s === 'for_sale' || s === 'for_rent';
  const listedLine = `${now.channel === 'rent' ? 'Listed for rent' : 'Listed for sale'} — ${now.price}.`;
  const at = { listingId: now.listingId };

  if (now.listingId !== seen.listingId) {
    // A campaign the buyer has not heard of.
    if (advertised(standing)) return [{ kind: 'listed', text: listedLine, ...at }];
    if (standing === 'under_offer') return [{ kind: 'under_offer', text: `Listed for sale and now under offer.`, ...at }];
    if (standing === 'sold') return [{ kind: 'sold', text: soldLine(now), ...at }];
    if (standing === 'leased') return [{ kind: 'leased', text: 'Leased.', ...at }];
    // A campaign that was never advertised while watched: nothing to tell.
    return [];
  }

  if (standing === seen.status) return [];
  if (standing === 'under_offer') return [{ kind: 'under_offer', text: 'Under offer.', ...at }];
  if (standing === 'sold') return [{ kind: 'sold', text: soldLine(now), ...at }];
  if (standing === 'leased') return [{ kind: 'leased', text: 'Leased.', ...at }];
  if (standing === 'not_advertised') return [{ kind: 'not_advertised', text: 'No longer advertised on this site.', ...at }];
  if (advertised(standing)) return [{ kind: seen.status === 'under_offer' ? 'back_on_market' : 'listed', text: seen.status === 'under_offer' ? `Back on the market — ${now.price}.` : listedLine, ...at }];
  return [];
}
