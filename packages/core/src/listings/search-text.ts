import { MAX_SEARCH_PLACES, type PropertyType } from './listing-schema';

/**
 * A sentence in the search box, read by plain rules (ADR 0101).
 *
 * `pakenham 10km 3 bed house under 800k` → Pakenham, 10 km, house, 3+ beds,
 * up to $800,000. No request and no model: this runs on every keystroke in the
 * browser. Everything it recognises is taken out of the sentence; what is left
 * is the place text, looked up by the geocoder as before.
 *
 * It reads only what the user wrote. A number appears here because the user
 * typed it, never because something guessed it.
 */
export type ParsedSearch = {
  /** The place words left over, split on "or", "and" and commas: each one is looked up. */
  places: string[];
  /** Kilometres around each place, 1–50. */
  km?: number;
  channel?: 'sale' | 'rent';
  newBuild?: boolean;
  types: PropertyType[];
  beds?: number;
  baths?: number;
  cars?: number;
  /** Dollars; dollars a week when `channel` is rent. */
  priceFrom?: number;
  priceTo?: number;
  /** True when anything besides a place was read: then the box offers the reading. */
  understood: boolean;
  /** Everything the rules did not read, as typed (before filler words are trimmed): what a model may still read. */
  rest?: string;
};

const MAX_KM = 50;
/** The ceiling search_listings and the URL accept; anything above is not a price someone typed on purpose. */
const MAX_PRICE = 50_000_000;

const TYPE_WORDS: [RegExp, PropertyType][] = [
  [/\btown\s?(?:house|home)s?\b/i, 'townhouse'],
  [/\bhouses?\b/i, 'house'],
  [/\b(?:apartments?|apts?|flats?)\b/i, 'apartment'],
  [/\bunits?\b/i, 'unit'],
  [/\bvillas?\b/i, 'villa'],
  [/\bduplex(?:es)?\b/i, 'duplex'],
  [/\bstudios?\b/i, 'studio'],
  [/\bacreages?\b/i, 'acreage'],
  [/\b(?:vacant\s+)?(?:land|blocks?\s+of\s+land)\b/i, 'land'],
  [/\brural\b/i, 'rural'],
];

const WORD_NUMBERS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', single: '1', double: '2', triple: '3',
};

// A price needs a sign of being money: "$", a k/m suffix, or five digits. So
// postcode 3810 and "14 Rogers Street" are never read as prices.
const MONEY = String.raw`\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|m|mil|million)?\b`;

function money(raw: string, unit: string | undefined, dollar: boolean): number | null {
  const n = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = unit?.toLowerCase();
  const value = u === 'k' ? n * 1_000 : u ? n * 1_000_000 : n;
  if (!dollar && !u && value < 10_000) return null;
  return value > MAX_PRICE ? null : Math.round(value);
}

/** Words that join a place to the rest and never start one. */
const LEAD = /^(?:(?:show\s+me|find\s+me|find|looking\s+for|i\s+want|search|add|also|plus|only|just|make\s+it|change\s+(?:it\s+)?to|homes?|propert(?:y|ies)|places?|for|with|within|in|at|near|nearby|close\s+to|around|of|from|radius|surrounding|a|an|and|or|to)\s+)+/i;
const TRAIL = /(?:\s+(?:area|region|surrounds|surrounding(?:\s+suburbs)?|suburbs?|and|or|with|in|near|for|homes?|propert(?:y|ies)))+$/i;

export function parseSearchText(input: string): ParsedSearch {
  let s = ` ${input} `;
  const out: ParsedSearch = { places: [], types: [], understood: false };
  const take = (re: RegExp, read: (m: RegExpExecArray) => boolean) => {
    const m = re.exec(s);
    if (m && read(m)) s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
  };

  s = s.replace(/\b(one|two|three|four|five|six|single|double|triple)\b(?=\s*(?:bed|bath|car|garage))/gi, (w) => WORD_NUMBERS[w.toLowerCase()]!);

  const weekly = /\b(?:pw|p\/w|per\s+week|a\s+week|\/\s?wk|weekly)\b/i.test(s);
  take(/\b(?:for\s+rent|to\s+rent|rentals?|renting|for\s+lease)\b/i, () => ((out.channel = 'rent'), true));
  take(/\b(?:for\s+sale|to\s+buy|buying)\b/i, () => ((out.channel ??= 'sale'), true));
  if (weekly) out.channel = 'rent';
  s = s.replace(/\b(?:pw|p\/w|per\s+week|a\s+week|\/\s?wk|weekly)\b/gi, ' ');
  s = s.replace(/\b(?:brand\s+new|new\s+builds?|new\s+homes?|off\s+the\s+plan|house\s+and\s+land)\b/gi, () => ((out.newBuild = true), ' '));

  take(
    /(?:\bwithin\s+|\+\s?)?(\d{1,3}(?:\.\d+)?)\s?(?:km|kms|kilomet(?:er|re)s?)\b(?:\s+radius)?(?:\s+(?:of|from|around|near)\b)?/i,
    (m) => {
      const km = Number(m[1]);
      if (!(km > 0)) return false;
      out.km = Math.min(MAX_KM, Math.max(1, Math.round(km)));
      return true;
    },
  );

  // "within 500m of": metres, before a price can read "500m" as $500 million.
  if (out.km === undefined) {
    take(/\b(?:within|radius(?:\s+of)?)\s+(\d{2,4})\s?(?:m|metres?|meters?)\b(?:\s+(?:of|from|around|near)\b)?/i, (m) => {
      out.km = Math.min(MAX_KM, Math.max(1, Math.round(Number(m[1]) / 1000)));
      return true;
    });
  }

  // Rooms before prices, so "2-3 bed" is a bedroom count and not a price range.
  take(/(\d{1,2})(?:\s?-\s?\d{1,2})?\s?\+?\s?(?:bed(?:room)?s?|br|bdrm?s?)\b/i, (m) => ((out.beds = Number(m[1])), true));
  take(/(\d)(?:\.5)?\s?\+?\s?(?:bath(?:room)?s?|bth)\b/i, (m) => ((out.baths = Number(m[1])), true));
  take(/(\d)\s?\+?\s?(?:cars?(?:\s?(?:spaces?|parks?|garages?|ports?))?|garages?|carports?|parking(?:\s+spaces?)?)\b/i, (m) => ((out.cars = Number(m[1])), true));

  take(new RegExp(String.raw`(?:\bbetween\s+)?${MONEY}\s?(?:-|–|\bto\b|\band\b)\s?${MONEY}`, 'i'), (m) => {
    const dollar = /\$/.test(m[0]);
    // "600-900k": the first number borrows the second's unit.
    const from = money(m[1]!, m[2] ?? m[4], dollar || !!m[4]);
    const to = money(m[3]!, m[4], dollar || !!m[4]);
    if (from === null || to === null || from > to) return false;
    out.priceFrom = from;
    out.priceTo = to;
    return true;
  });
  if (out.priceTo === undefined) {
    take(new RegExp(String.raw`\b(?:under|below|less\s+than|max(?:imum)?|up\s?to|no\s+more\s+than|budget(?:\s+of)?)\s+${MONEY}`, 'i'), (m) => {
      const v = money(m[1]!, m[2], /\$/.test(m[0]) || weekly);
      return v === null ? false : ((out.priceTo = v), true);
    });
  }
  if (out.priceFrom === undefined) {
    take(new RegExp(String.raw`\b(?:over|above|more\s+than|min(?:imum)?|from|at\s+least|starting\s+(?:at|from))\s+${MONEY}`, 'i'), (m) => {
      const v = money(m[1]!, m[2], /\$/.test(m[0]) || weekly);
      return v === null ? false : ((out.priceFrom = v), true);
    });
  }
  if (out.priceTo === undefined && out.priceFrom === undefined) {
    // A bare amount is a budget: "pakenham 800k".
    take(new RegExp(MONEY, 'i'), (m) => {
      const v = money(m[1]!, m[2], /\$/.test(m[0]));
      return v === null ? false : ((out.priceTo = v), true);
    });
  }

  for (const [re, type] of TYPE_WORDS) {
    take(re, () => (out.types.includes(type) || out.types.push(type), true));
  }

  out.rest = s.replace(/\s+/g, ' ').trim();
  out.places = s
    .split(/\s*(?:,|;|&|\/|\bor\b|\band\b)\s*/i)
    .map((p) => p.replace(/\s+/g, ' ').trim().replace(LEAD, '').replace(TRAIL, '').trim())
    .filter((p) => p.length >= 2 && /[a-z0-9]/i.test(p) && !LEAD.test(`${p} `))
    .slice(0, MAX_SEARCH_PLACES);

  out.understood =
    out.km !== undefined ||
    out.beds !== undefined ||
    out.baths !== undefined ||
    out.cars !== undefined ||
    out.priceFrom !== undefined ||
    out.priceTo !== undefined ||
    out.types.length > 0 ||
    out.channel !== undefined ||
    out.newBuild === true;
  return out;
}
