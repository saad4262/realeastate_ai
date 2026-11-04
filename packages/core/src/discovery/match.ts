import type { ProfileFacts } from '../profile/derive';

/**
 * Discovery AI's rules (ADR 0080, C7 decisions 1–2; mock docs/mocks/consumer-discovery.html). Pure: the database
 * returns homes that pass the hard filters (public, the channel, the kinds, within budget, the suburbs or 5 km of
 * them); this decides what each card says and in what order. No model picks, scores or writes any of it.
 *
 * A suggestion may differ from what was asked on ONE thing, and says which: a suburb not asked for but within 5 km
 * (straight line), one more bedroom, or no price given. Never over budget, never another kind of home.
 */

export const DISCOVERY_RADIUS_METRES = 5_000;
export const MAX_FOR_YOU = 12;
export const MAX_SIMILAR = 6;
export const MAX_NOT_FOR_SALE = 3;
/** A home bought less than this long ago is never suggested to someone else (decision 3). */
export const NOT_FOR_SALE_AFTER_MONTHS = 12;
/** Similar homes: the asking price within this share of the listing's own (either way). */
export const SIMILAR_PRICE_BAND = 0.1;
/** What the database hands over before the rules choose; far more than any page shows. */
export const CANDIDATE_LIMIT = 100;
export const MAX_HIDDEN = 500;

/** What a set of suggestions is for. `anchor` names where "nearby" is measured from. */
export type DiscoveryAsk = {
  from: 'listing' | 'profile';
  channel: 'sale' | 'rent';
  /** Suburbs a home may be in without counting as a difference. Lower-cased by the reader. */
  suburbs: string[];
  /** With `from: 'listing'`, the listing's state: a same-named suburb elsewhere is not "the same suburb". */
  state: string | null;
  /** Kinds of home (`house`, `apartment`…); empty = any. Never relaxed. */
  propertyTypes: string[];
  /** Exactly this many, or one more (a difference). Null = any. */
  bedrooms: number | null;
  /** Profile: the budget — the top of a home's price at or under it. */
  priceTo: number | null;
  /** Similar homes: the listing's own price; a home within ±10% of it. */
  priceNear: number | null;
};

/** A home the database found, before the rules. Every figure as SQL returned it. */
export type CandidateRow = {
  listingId: string;
  propertyId: string;
  address: string;
  suburb: string;
  state: string;
  price: string;
  /** The top of the asking price (rent a week for a rental), or null when the ad gives none. */
  topPrice: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  propertyType: string | null;
  /** In one of the asked suburbs (and the state, for a listing). */
  inSuburb: boolean;
  /** The nearest anchor — the listing itself, or the middle of a profile suburb — and the straight-line metres to it. */
  nearName: string | null;
  nearMetres: number | null;
  publishedAt: Date | null;
};

export type Difference = { kind: 'nearby'; suburb: string; from: string; metres: number } | { kind: 'one_more_bedroom'; bedrooms: number; wanted: number } | { kind: 'no_price' };

export type Suggestion = {
  listingId: string;
  propertyId: string;
  address: string;
  suburb: string;
  state: string;
  price: string;
  bedrooms: number | null;
  bathrooms: number | null;
  propertyType: string | null;
  /** What it matches, as the card's chips. */
  matches: string[];
  /** The one thing it differs on, or null. */
  difference: Difference | null;
  differenceText: string | null;
  /** Straight-line metres from the anchor; null when unknown. */
  metres: number | null;
};

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

export function kmText(metres: number): string {
  return `${(Math.round(metres / 100) / 10).toFixed(1)} km`;
}

const plural = (type: string) => (/(s|sh|ch|x)$/.test(type) ? `${type}es` : `${type}s`);

export function differenceText(d: Difference, from: DiscoveryAsk['from']): string {
  switch (d.kind) {
    case 'nearby':
      return from === 'listing' ? `${d.suburb} · ${kmText(d.metres)} away` : `${d.suburb} · ${kmText(d.metres)} from ${d.from}`;
    case 'one_more_bedroom':
      return from === 'listing' ? `${d.bedrooms} bed · one more` : `${d.bedrooms} bed · one more than your ${d.wanted}`;
    case 'no_price':
      return 'No price given';
  }
}

/**
 * The differences a candidate has against the ask, or null when it is never suggested: outside 5 km, another kind of
 * home, over budget, outside the price band, or a bedroom count that is neither the one asked for nor one more. Pure.
 */
export function differencesOf(row: CandidateRow, ask: DiscoveryAsk): Difference[] | null {
  const out: Difference[] = [];
  if (!row.inSuburb) {
    if (row.nearMetres === null || row.nearMetres > DISCOVERY_RADIUS_METRES || !row.nearName) return null;
    out.push({ kind: 'nearby', suburb: row.suburb, from: row.nearName, metres: row.nearMetres });
  }
  if (ask.bedrooms !== null) {
    if (row.bedrooms !== ask.bedrooms && row.bedrooms !== ask.bedrooms + 1) return null;
    if (row.bedrooms === ask.bedrooms + 1) out.push({ kind: 'one_more_bedroom', bedrooms: row.bedrooms, wanted: ask.bedrooms });
  }
  if (ask.propertyTypes.length && (!row.propertyType || !ask.propertyTypes.includes(row.propertyType.toLowerCase()))) return null;
  if (ask.priceTo !== null || ask.priceNear !== null) {
    if (row.topPrice === null) out.push({ kind: 'no_price' });
    else if (ask.priceTo !== null && row.topPrice > ask.priceTo) return null;
    else if (ask.priceNear !== null && Math.abs(row.topPrice - ask.priceNear) > ask.priceNear * SIMILAR_PRICE_BAND) return null;
  }
  return out;
}

/** The chips: what a suggestion matches, in the order the card reads. Pure. */
export function matchChips(row: CandidateRow, ask: DiscoveryAsk, diff: Difference | null): string[] {
  const chips: string[] = [];
  if (row.inSuburb) chips.push(row.suburb);
  if (ask.bedrooms !== null && row.bedrooms === ask.bedrooms) chips.push(`${row.bedrooms} bed`);
  if (ask.propertyTypes.length && row.propertyType) chips.push(row.propertyType.toLowerCase());
  if (diff?.kind !== 'no_price' && row.topPrice !== null) {
    if (ask.priceTo !== null) chips.push(row.topPrice === ask.priceTo ? `up to ${AUD.format(ask.priceTo)}` : `under ${AUD.format(ask.priceTo)}`);
    else if (ask.priceNear !== null) chips.push(`within ${Math.round(SIMILAR_PRICE_BAND * 100)}% of the price`);
  }
  return chips;
}

/**
 * The cards, in order: fewest differences, then nearest, then newest. At most one difference each; anything else is
 * not suggested. Pure — the database decided what is public and within budget; this cannot widen it.
 */
export function rankSuggestions(rows: readonly CandidateRow[], ask: DiscoveryAsk, limit: number, exclude: ReadonlySet<string> = new Set()): Suggestion[] {
  const seen = new Set<string>(exclude);
  const scored: { s: Suggestion; diffs: number; metres: number; published: number }[] = [];
  for (const row of rows) {
    if (seen.has(row.propertyId)) continue;
    const diffs = differencesOf(row, ask);
    if (!diffs || diffs.length > 1) continue;
    seen.add(row.propertyId);
    const difference = diffs[0] ?? null;
    scored.push({
      s: {
        listingId: row.listingId,
        propertyId: row.propertyId,
        address: row.address,
        suburb: row.suburb,
        state: row.state,
        price: row.price,
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        propertyType: row.propertyType,
        matches: matchChips(row, ask, difference),
        difference,
        differenceText: difference ? differenceText(difference, ask.from) : null,
        metres: row.nearMetres,
      },
      diffs: diffs.length,
      metres: row.inSuburb ? 0 : (row.nearMetres ?? Number.MAX_SAFE_INTEGER),
      published: row.publishedAt?.getTime() ?? 0,
    });
  }
  scored.sort((a, b) => a.diffs - b.diffs || a.metres - b.metres || b.published - a.published || a.s.listingId.localeCompare(b.s.listingId));
  return scored.slice(0, limit).map((x) => x.s);
}

/** Why For you cannot run from this profile, or null when it can. */
export type ProfileGap = 'no_suburbs';

/** The ask from a Personal Property AI profile (decision 1): its facts as they stand, the buyer's edits included. Pure. */
export function profileAsk(facts: ProfileFacts): { ask: DiscoveryAsk } | { gap: ProfileGap } {
  const suburbs = (facts.suburbs?.value ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!suburbs.length) return { gap: 'no_suburbs' };
  return {
    ask: {
      from: 'profile',
      channel: facts.channel?.value ?? 'sale',
      suburbs,
      state: null,
      propertyTypes: (facts.propertyTypes?.value ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
      bedrooms: facts.bedrooms?.value ?? null,
      priceTo: facts.priceTo?.value ?? null,
      priceNear: null,
    },
  };
}

/** How the profile reads on the For you page and to the guide — the facts the suggestions used. Pure. */
export function askSummary(ask: DiscoveryAsk): { label: string; value: string }[] {
  const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  return [
    { label: 'Suburbs', value: ask.suburbs.map(title).join(', ') },
    { label: ask.channel === 'rent' ? 'Renting' : 'Buying', value: ask.channel === 'rent' ? 'To rent' : 'For sale' },
    ...(ask.priceTo !== null ? [{ label: 'Up to', value: ask.channel === 'rent' ? `${AUD.format(ask.priceTo)} a week` : AUD.format(ask.priceTo) }] : []),
    ...(ask.bedrooms !== null ? [{ label: 'Bedrooms', value: String(ask.bedrooms) }] : []),
    ...(ask.propertyTypes.length ? [{ label: 'Kind', value: ask.propertyTypes.map((t) => title(plural(t))).join(', ') }] : []),
  ];
}
