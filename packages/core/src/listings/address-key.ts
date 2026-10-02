/**
 * One spelling for an address, so the same dwelling is found again.
 *
 * A property outlives its listings (#1): a house sold by one agency in 2015 and
 * listed by another in 2026 must be ONE property row, or its sale history is
 * split in two and the new listing shows none of it. The second agency types
 * the address themselves, and nobody types an address the same way twice —
 * "St" or "Street", "Unit 3" or "3", "6e" or "6E", a stray full stop. Matching
 * the raw columns treated every one of those as a different house.
 *
 * Deliberately conservative. Each rule here only folds two spellings of the
 * SAME thing together; nothing guesses. Two different houses merging is far
 * worse than one house split in two — it would publish one vendor's sale price
 * on another's listing — so a doubtful case stays apart.
 *
 * Pure, so it is tested without a database and used the same way by every
 * caller.
 */

export type AddressParts = {
  unit?: string | null;
  streetNumber?: string | null;
  street?: string | null;
  suburb: string;
  state: string;
  postcode: string;
};

/**
 * Street-type abbreviations, folded to the full word.
 *
 * Applied to every word of the street name, not only the last, so that both
 * sides are folded identically — "St Kilda Rd" becomes "street kilda road" on
 * both sides and still matches itself. What is NOT here is anything ambiguous
 * between two different street types, and directions ("N", "E"): "6E" is a
 * street number and "E" alone could be East or a typo.
 */
const STREET_TYPES: Record<string, string> = {
  st: 'street',
  str: 'street',
  rd: 'road',
  ave: 'avenue',
  av: 'avenue',
  dr: 'drive',
  drv: 'drive',
  ct: 'court',
  crt: 'court',
  cres: 'crescent',
  cr: 'crescent',
  cct: 'circuit',
  pde: 'parade',
  pl: 'place',
  hwy: 'highway',
  blvd: 'boulevard',
  bvd: 'boulevard',
  cl: 'close',
  tce: 'terrace',
  ln: 'lane',
  gr: 'grove',
  gve: 'grove',
  esp: 'esplanade',
  prom: 'promenade',
  sq: 'square',
  wy: 'way',
  pkwy: 'parkway',
};

/** Words in front of a unit number that say what it is, not which one. */
const UNIT_PREFIX = /^(unit|apartment|apt|flat|villa|townhouse|u)\s*/;

const squash = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "6 E", "6e" and "6E" are one street number. */
const compact = (s: string) => s.replace(/[\s-]/g, '');

export function normaliseStreet(street: string | null | undefined): string {
  return squash(street)
    .split(' ')
    .filter(Boolean)
    .map((w) => STREET_TYPES[w] ?? w)
    .join(' ');
}

/**
 * The comparable key for a dwelling.
 *
 * A unit written into the street number ("32/6E" with no unit) is split out,
 * because that is how most people write a unit and the form has a separate
 * box for it that many will not use.
 */
export function addressKey(a: AddressParts): string {
  let unit = squash(a.unit);
  let number = squash(a.streetNumber);

  if (!unit && number.includes('/')) {
    const at = number.indexOf('/');
    unit = number.slice(0, at);
    number = number.slice(at + 1);
  }

  unit = compact(unit.replace(UNIT_PREFIX, ''));
  number = compact(number);

  return [
    unit,
    number,
    normaliseStreet(a.street),
    squash(a.suburb),
    a.state.trim().toUpperCase(),
    a.postcode.trim(),
  ].join('|');
}
