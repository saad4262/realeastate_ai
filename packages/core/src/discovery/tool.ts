import type { ForYou, SimilarHomes } from './discovery';
import type { Suggestion } from './match';

/**
 * Discovery AI in the guide (ADR 0080, C7 decision 9): the records the pages show, as code-written lines. The guide
 * copies them and links the page; it never picks, ranks or values a home itself.
 */
export type DiscoverToolResult =
  | { found: false; reason: 'profile_off' | 'no_suburbs' | 'listing_not_public' | 'signed_out'; note: string }
  | {
      found: true;
      from: 'listing' | 'profile';
      basis: string[];
      homes: { listingId: string; line: string; matches: string[]; difference: string | null; page: string }[];
      notForSale: { propertyId: string; line: string; page: string }[];
      page: string;
      rules: string;
    };

const RULES =
  'Copy each home as given, with its one difference when it has one. Homes not for sale are not for sale: say so, and that the owner may not want to sell; offer watching the address. Never call a home a bargain or good value, never guess a value, and never add a home that is not in this result.';

const line = (h: Suggestion) => [h.address, [h.bedrooms !== null ? `${h.bedrooms} bed` : null, h.propertyType, h.price].filter(Boolean).join(' · ')].join(' — ');

/** For a visitor who is not signed in and named no listing: there is no profile to read. */
export const SIGNED_OUT_DISCOVERY: DiscoverToolResult = { found: false, reason: 'signed_out', note: 'Suggestions from a profile need them signed in with Personal Property AI on. Offer homes like a listing they name instead.' };

/** Pure. */
export function discoverToolResult(x: SimilarHomes | ForYou | null): DiscoverToolResult {
  if (!x) return { found: false, reason: 'listing_not_public', note: 'That home is not advertised on the portal now. Say so.' };
  if ('listingId' in x) {
    return {
      found: true,
      from: 'listing',
      basis: [`the suburb, kind, bedrooms and price of listing ${x.listingId}`],
      homes: x.homes.map((h) => ({ listingId: h.listingId, line: line(h), matches: h.matches, difference: h.differenceText, page: `/listing/${h.listingId}` })),
      notForSale: [],
      page: `/listing/${x.listingId}#similar`,
      rules: RULES,
    };
  }
  if (x.state === 'profile_off') return { found: false, reason: 'profile_off', note: "Personal Property AI is off, so there is no profile to suggest from. Say so; offer to suggest homes like a listing they name, or to switch it on in Skills. Never guess what they like." };
  if (x.state === 'gap') return { found: false, reason: 'no_suburbs', note: 'Their profile has no suburbs yet. Ask which suburbs they are looking in, or suggest homes like a listing they name.' };
  return {
    found: true,
    from: 'profile',
    basis: x.summary.map((s) => `${s.label}: ${s.value}`),
    homes: x.homes.map((h) => ({ listingId: h.listingId, line: line(h), matches: h.matches, difference: h.differenceText, page: `/listing/${h.listingId}` })),
    notForSale: x.notForSale.map((n) => ({ propertyId: n.propertyId, line: `${n.address} — not for sale; sold on this site in ${n.soldText}`, page: `/property/${n.propertyId}` })),
    page: '/account/for-you',
    rules: RULES,
  };
}
