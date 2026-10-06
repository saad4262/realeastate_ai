import { z } from 'zod';
import { listingDraftSchema, propertyDraftSchema, propertyTypeSchema, soldDetailsSchema } from '../listings/listing-schema';
import { localInputToInstant } from '../time/local-input';

/**
 * The import's columns (ADR 0029 "The CSV template", docs/import/listings-template.csv),
 * derived from the console's own listing contract — and the one place a row's
 * cells become a property draft, a listing draft, a status and its extras.
 * Every check here is the form's own schema; nothing is parsed at query time.
 */

export const IMPORT_FIELDS = [
  'external_id', 'unit', 'street_number', 'street', 'suburb', 'state', 'postcode', 'property_type',
  'bedrooms', 'bathrooms', 'car_spaces', 'land_area_sqm', 'building_area_sqm', 'year_built',
  'channel', 'status', 'headline', 'description', 'price_display', 'price_from', 'price_to', 'rent_pw',
  'available_from', 'auction_at', 'listed_on', 'sold_price', 'sold_date', 'agent_emails', 'photo_urls',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Columns without which no row can be imported. */
export const REQUIRED_FIELDS: readonly ImportField[] = ['suburb', 'state', 'postcode', 'channel', 'status', 'headline'];

export const FIELD_LABELS: Record<ImportField, string> = {
  external_id: 'Your listing id', unit: 'Unit', street_number: 'Street number', street: 'Street', suburb: 'Suburb',
  state: 'State', postcode: 'Postcode', property_type: 'Property type', bedrooms: 'Bedrooms', bathrooms: 'Bathrooms',
  car_spaces: 'Car spaces', land_area_sqm: 'Land (m²)', building_area_sqm: 'Building (m²)', year_built: 'Year built',
  channel: 'Sale or rent', status: 'Status', headline: 'Headline', description: 'Description', price_display: 'Price text',
  price_from: 'Price from', price_to: 'Price to', rent_pw: 'Rent per week', available_from: 'Available from',
  auction_at: 'Auction', listed_on: 'Listed on', sold_price: 'Sold price', sold_date: 'Sold date',
  agent_emails: 'Agent emails', photo_urls: 'Photo links',
};

/** Our field → the file's column index, or null when the file has no such column. */
export type ImportMapping = Partial<Record<ImportField, number | null>>;

const SYNONYMS: Record<string, ImportField> = {
  id: 'external_id', listing_id: 'external_id', ref: 'external_id', reference: 'external_id',
  unit_number: 'unit', number: 'street_number', street_no: 'street_number', street_name: 'street', address: 'street',
  type: 'property_type', beds: 'bedrooms', baths: 'bathrooms', cars: 'car_spaces', parking: 'car_spaces', car_parks: 'car_spaces',
  land: 'land_area_sqm', land_size: 'land_area_sqm', building_size: 'building_area_sqm', title: 'headline',
  price: 'price_display', price_text: 'price_display', rent: 'rent_pw', weekly_rent: 'rent_pw', auction: 'auction_at',
  listed: 'listed_on', date_listed: 'listed_on', agents: 'agent_emails', agent: 'agent_emails', agent_email: 'agent_emails',
  photos: 'photo_urls', images: 'photo_urls', photo_links: 'photo_urls',
};

const key = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** A first guess at the mapping from the header row (the template's own names, then common synonyms). */
export function autoMap(headers: readonly string[]): ImportMapping {
  const out: ImportMapping = {};
  headers.forEach((h, i) => {
    const k = key(h);
    const field = (IMPORT_FIELDS as readonly string[]).includes(k) ? (k as ImportField) : SYNONYMS[k];
    if (field && out[field] === undefined) out[field] = i;
  });
  for (const f of IMPORT_FIELDS) if (out[f] === undefined) out[f] = null;
  return out;
}

export const importMappingSchema = z.record(z.enum(IMPORT_FIELDS), z.number().int().min(0).max(500).nullable());

export const IMPORT_STATUSES = ['live', 'under_offer', 'sold', 'withdrawn', 'draft'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** What a valid row becomes. Stored as `normalized`; the import writes exactly this. */
export type NormalizedRow = {
  externalId: string | null;
  /** Input shapes as JSON (dates are ISO strings); createListing parses them again with the form's schemas. */
  property: z.input<typeof propertyDraftSchema>;
  listing: Omit<z.input<typeof listingDraftSchema>, 'availableFrom' | 'auctionDate'> & { availableFrom?: string; auctionDate?: string };
  status: ImportStatus;
  sold: { soldPrice: number; soldDate: string } | null;
  agentEmails: string[];
  photoUrls: string[];
  listedOn: string | null;
};

export type CellError = { column: string; message: string };

/** "$850,000" and "850000" → 850000; "$1.2m", "850k", "Offers over" → error. Never guessed. */
export function parseMoney(v: string): number | null | 'invalid' {
  const t = v.trim();
  if (!t) return null;
  const bare = t.replace(/^\$/, '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(bare)) return 'invalid';
  return Number(bare);
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One row's cells → a NormalizedRow, or the reasons it cannot be one. Every
 * problem is reported at once, in plain words, against the column it is in.
 */
export function normalizeRow(cells: readonly string[], mapping: ImportMapping, timeZone: string): { row: NormalizedRow | null; errors: CellError[] } {
  const errors: CellError[] = [];
  const get = (f: ImportField) => {
    const i = mapping[f];
    return i === null || i === undefined ? '' : (cells[i] ?? '').trim();
  };
  const err = (f: ImportField, message: string) => errors.push({ column: FIELD_LABELS[f], message });
  const num = (f: ImportField) => {
    const v = get(f);
    if (!v) return undefined;
    const n = Number(v.replace(/,/g, ''));
    if (!Number.isFinite(n)) {
      err(f, `“${v}” is not a number`);
      return undefined;
    }
    return n;
  };
  const money = (f: ImportField) => {
    const p = parseMoney(get(f));
    if (p === 'invalid') {
      err(f, `“${get(f)}” — write whole dollars like 850000 (put text such as “Offers over” in Price text)`);
      return undefined;
    }
    return p ?? undefined;
  };
  const date = (f: ImportField) => {
    const v = get(f);
    if (!v) return undefined;
    if (!isoDate.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
      err(f, `“${v}” — dates are written YYYY-MM-DD, e.g. 2026-11-14`);
      return undefined;
    }
    return v;
  };

  for (const f of REQUIRED_FIELDS) if (!get(f)) err(f, 'is required');

  const channel = get('channel').toLowerCase();
  if (channel && channel !== 'sale' && channel !== 'rent') err('channel', `“${get('channel')}” — use sale or rent`);
  const statusRaw = get('status').toLowerCase().replace(/[\s-]+/g, '_');
  const status = (IMPORT_STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as ImportStatus) : null;
  if (get('status') && !status) err('status', `“${get('status')}” — use live, under_offer, sold, withdrawn or draft`);

  let propertyType: string | undefined;
  if (get('property_type')) {
    const pt = propertyTypeSchema.safeParse(get('property_type'));
    if (pt.success) propertyType = pt.data;
    else err('property_type', `“${get('property_type')}” is not one of the property types`);
  }

  const property = {
    ...(get('unit') ? { unit: get('unit') } : {}),
    ...(get('street_number') ? { streetNumber: get('street_number') } : {}),
    ...(get('street') ? { street: get('street') } : {}),
    suburb: get('suburb'),
    state: get('state').toUpperCase(),
    postcode: get('postcode'),
    ...(propertyType ? { propertyType } : {}),
    ...(num('bedrooms') !== undefined ? { bedrooms: num('bedrooms') } : {}),
    ...(num('bathrooms') !== undefined ? { bathrooms: num('bathrooms') } : {}),
    ...(num('car_spaces') !== undefined ? { carSpaces: num('car_spaces') } : {}),
    ...(num('land_area_sqm') !== undefined ? { landAreaSqm: num('land_area_sqm') } : {}),
    ...(num('building_area_sqm') !== undefined ? { buildingAreaSqm: num('building_area_sqm') } : {}),
    ...(num('year_built') !== undefined ? { yearBuilt: num('year_built') } : {}),
  };
  const auctionRaw = get('auction_at');
  let auctionDate: string | undefined;
  if (auctionRaw) {
    const at = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(auctionRaw) ? localInputToInstant(auctionRaw.replace(' ', 'T'), timeZone) : null;
    if (at) auctionDate = at.toISOString();
    else err('auction_at', `“${auctionRaw}” — write it YYYY-MM-DD HH:mm, e.g. 2026-11-14 11:00`);
  }
  const listing = {
    channel: (channel || 'sale') as 'sale' | 'rent',
    headline: get('headline'),
    ...(get('description') ? { description: get('description') } : {}),
    ...(get('price_display') ? { priceDisplay: get('price_display') } : {}),
    ...(money('price_from') !== undefined ? { priceFrom: money('price_from') } : {}),
    ...(money('price_to') !== undefined ? { priceTo: money('price_to') } : {}),
    ...(money('rent_pw') !== undefined ? { rentPw: money('rent_pw') } : {}),
    ...(date('available_from') ? { availableFrom: date('available_from') } : {}),
    ...(auctionDate ? { auctionDate } : {}),
  };

  // The form's own rules, word for word.
  const p = propertyDraftSchema.safeParse(property);
  if (!p.success) for (const i of p.error.issues) errors.push({ column: String(i.path[0] ?? 'Address'), message: i.message });
  const l = listingDraftSchema.safeParse(listing);
  if (!l.success) for (const i of l.error.issues) errors.push({ column: String(i.path[0] ?? 'Listing'), message: i.message });
  if (!get('street') && get('street_number')) err('street', 'is required when there is a street number');

  let sold: NormalizedRow['sold'] = null;
  const soldPrice = money('sold_price');
  const soldDate = date('sold_date');
  if (status === 'sold') {
    const s = soldDetailsSchema.safeParse({ soldPrice, soldDate });
    if (!s.success) for (const i of s.error.issues) err(i.path[0] === 'soldDate' ? 'sold_date' : 'sold_price', i.message);
    else sold = { soldPrice: s.data.soldPrice, soldDate: s.data.soldDate.toISOString() };
  } else if (soldPrice !== undefined || soldDate) {
    err('sold_price', 'a sold price or date only belongs on a row whose status is sold');
  }

  const agentEmails = get('agent_emails')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  for (const e of agentEmails) if (!z.string().email().safeParse(e).success) err('agent_emails', `“${e}” is not an email address`);
  if (agentEmails.length > 10) err('agent_emails', 'at most 10 agents');

  const photoUrls = get('photo_urls')
    .split('|')
    .map((u) => u.trim())
    .filter(Boolean);
  for (const u of photoUrls) {
    let ok = false;
    try {
      ok = ['http:', 'https:'].includes(new URL(u).protocol);
    } catch {
      ok = false;
    }
    if (!ok) err('photo_urls', `“${u.slice(0, 80)}” is not a web link`);
  }
  if (photoUrls.length > 30) err('photo_urls', 'at most 30 photos per listing');

  const listedOn = date('listed_on') ?? null;
  const externalId = get('external_id').slice(0, 120) || null;

  if (errors.length || !status) return { row: null, errors };
  return {
    // Validated above by the form's own schemas; kept in input form (it is JSON, and createListing parses it again).
    row: { externalId, property: property as NormalizedRow['property'], listing, status, sold, agentEmails, photoUrls, listedOn },
    errors: [],
  };
}
