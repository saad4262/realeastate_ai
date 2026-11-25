import { z } from 'zod';
import { MAX_SEARCH_PLACES, PROPERTY_TYPES, type PropertyType } from './listing-schema';
import { parseSearchText, type ParsedSearch } from './search-text';

/**
 * The AI half of smart search (ADR 0101): what a model read from a sentence the
 * rules could not finish, checked against the user's own words before any of it
 * is used.
 *
 * The model only fills fields the search already has. It never supplies
 * coordinates (places are looked up by the geocoder, as when typed) and never
 * supplies a number the user did not write (#4): every number it returns must
 * be one the sentence contains, or the field is dropped. Where the rules read
 * something, the rules win.
 */
export const SEARCH_UNDERSTAND_FEATURE = 'search:understand';

/** The longest sentence sent to the model; the box allows 200. */
export const MAX_UNDERSTAND_CHARS = 300;

export type UnderstoodSearch = ParsedSearch & {
  /** Words to match in listing text ("pool", "double garage"): a keyword search, labelled as one. */
  keywords: string[];
  /** What was asked but cannot be searched here ("near a good school", "15 min to the CBD"). Shown, never guessed. */
  notSearchable: string[];
};

/** A model-written answer, read field by field: a bad field is dropped, never the whole answer. */
const loose = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined);
const words = (max: number, each: number) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((list) =>
      list
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.replace(/\s+/g, ' ').trim().slice(0, each))
        .filter((v) => v.length >= 2)
        .slice(0, max),
    );

export const rawUnderstoodSchema = z
  .object({
    places: words(MAX_SEARCH_PLACES, 80),
    km: loose(z.number().positive()),
    channel: loose(z.enum(['sale', 'rent'])),
    new_build: loose(z.boolean()),
    types: z
      .array(z.unknown())
      .catch([])
      .transform((list) =>
        list
          .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
          .filter((v): v is PropertyType => (PROPERTY_TYPES as readonly string[]).includes(v) && v !== 'other'),
      ),
    beds: loose(z.number().int().positive()),
    baths: loose(z.number().int().positive()),
    cars: loose(z.number().int().positive()),
    price_from: loose(z.number().positive()),
    price_to: loose(z.number().positive()),
    keywords: words(3, 40),
    not_searchable: words(3, 60),
  })
  .passthrough()
  .catch({ places: [], types: [], keywords: [], not_searchable: [] });

export type RawUnderstood = z.infer<typeof rawUnderstoodSchema>;

/** The model call, supplied by packages/ai (#3). Returns its JSON; this module decides what survives. */
export type SearchUnderstander = (input: { text: string }) => Promise<unknown>;

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, single: 1, double: 2, triple: 3 };

/** Every number the sentence actually contains, with its k/m meaning: the only numbers a model may hand back. */
/** A sale price under $10,000 or a weekly rent over $20,000 is a typo or a trick, not a budget. */
export function plausiblePrice(n: number | undefined, rent: boolean): number | undefined {
  if (n === undefined) return undefined;
  return rent ? (n <= 20_000 ? n : undefined) : n >= 10_000 ? n : undefined;
}

export function numbersIn(text: string): Set<number> {
  const found = new Set<number>();
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|m|mil|million)?\b/gi)) {
    const n = Number(m[1]!.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const u = m[2]?.toLowerCase();
    found.add(u === 'k' ? n * 1_000 : u ? Math.round(n * 1_000_000) : n);
    if (!u) found.add(n);
  }
  for (const w of text.toLowerCase().match(/\b(?:one|two|three|four|five|six|single|double|triple)\b/g) ?? []) {
    found.add(WORD_NUMBERS[w]!);
  }
  return found;
}

/** A phrase is kept only when its words are in the sentence: a model cannot add a keyword nobody typed. */
const typedIn = (text: string) => {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return (phrase: string) => {
    const needle = phrase.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return needle.length >= 2 && hay.includes(` ${needle} `);
  };
};

/**
 * The reading to use: the rules' reading, with the model's filling only what
 * the rules left empty, and only with what the sentence contains.
 */
export function verifyUnderstood(raw: unknown, text: string): UnderstoodSearch {
  const rules = parseSearchText(text);
  const ai = rawUnderstoodSchema.parse(raw ?? {});
  const numbers = numbersIn(text);
  const said = (n: number | undefined) => (n !== undefined && numbers.has(n) ? n : undefined);
  // A keyword or an ask must be words the rules left over: "double garage" already
  // became 2 car spaces, and as a keyword too it would demand those exact words.
  const leftover = typedIn(rules.rest ?? '');

  const km = rules.km ?? (said(ai.km) !== undefined ? Math.min(50, Math.max(1, Math.round(ai.km!))) : undefined);
  const channel = rules.channel ?? ai.channel;
  // Typed, but not a price anyone means: a home for under $10,000, or rent over $20,000 a week.
  const plausible = (n: number | undefined) => plausiblePrice(n, channel === 'rent');
  let priceFrom = plausible(rules.priceFrom ?? said(ai.price_from));
  let priceTo = plausible(rules.priceTo ?? said(ai.price_to));
  if (priceFrom !== undefined && priceTo !== undefined && priceFrom > priceTo) priceFrom = priceTo = undefined;

  const out: UnderstoodSearch = {
    // The model's places are cleaner than the rules' leftovers ("pool in berwick" → "Berwick"); the geocoder still checks each.
    places: ai.places.length ? ai.places : rules.places,
    ...(km !== undefined ? { km } : {}),
    ...(channel ? { channel } : {}),
    ...(rules.newBuild || ai.new_build ? { newBuild: true } : {}),
    types: rules.types.length ? rules.types : [...new Set(ai.types)],
    ...((rules.beds ?? said(ai.beds)) !== undefined ? { beds: rules.beds ?? said(ai.beds)! } : {}),
    ...((rules.baths ?? said(ai.baths)) !== undefined ? { baths: rules.baths ?? said(ai.baths)! } : {}),
    ...((rules.cars ?? said(ai.cars)) !== undefined ? { cars: rules.cars ?? said(ai.cars)! } : {}),
    ...(priceFrom !== undefined ? { priceFrom } : {}),
    ...(priceTo !== undefined ? { priceTo } : {}),
    keywords: ai.keywords.filter(leftover),
    notSearchable: ai.not_searchable.filter(leftover),
    understood: false,
  };
  out.understood =
    out.km !== undefined || out.beds !== undefined || out.baths !== undefined || out.cars !== undefined ||
    out.priceFrom !== undefined || out.priceTo !== undefined || out.types.length > 0 || !!out.channel ||
    !!out.newBuild || out.keywords.length > 0 || out.notSearchable.length > 0;
  return out;
}

/** Read a sentence with the model, then keep only what checks out. Throws when the model does (the caller falls back to the rules). */
export async function understandSearch(text: string, understander: SearchUnderstander): Promise<UnderstoodSearch> {
  const sentence = text.replace(/\s+/g, ' ').trim().slice(0, MAX_UNDERSTAND_CHARS);
  return verifyUnderstood(await understander({ text: sentence }), sentence);
}
