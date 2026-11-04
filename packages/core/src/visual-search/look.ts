import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '@repo/db';
import { PUBLIC_STATUS } from '../listings/search-listings';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';
import { factSql } from '../listings/facts';
import { priceText } from '../due-diligence/records';
import { mediaUrl } from '../media/media-url';

/**
 * Visual Search AI (ADR 0080, C9 decisions 8–11; mock docs/mocks/consumer-media-land.html#visual). Homes whose photos
 * look like a description or like one photo on this site, by Voyage multimodal vectors kept in our own Postgres.
 *
 * Postgres applies the buyer's filters first — public listings, channel, area, price, bedrooms, kind — and the vectors
 * only order what passes (decision 10): every candidate's distance is computed exactly, so no filter is ever traded
 * for speed. A card says "Looks similar" with the photo that matched; no score, no word about condition or quality,
 * nothing written into the ad. No buyer uploads (decision 9). Below 500 searchable photos it says it is still filling
 * up (decision 11). Embedding new photos is OFF until the platform switches it on (the user, 2026-11-04).
 */

export const VISUAL_MODEL = 'voyage-multimodal-3.5';
export const VISUAL_DIMENSIONS = 1024;
export const VISUAL_SEARCH_FEATURE = 'consumer:visual_search';
export const VISUAL_EMBED_FEATURE = 'consumer:visual_embed';
/** Decision 11: below this many searchable photos on public listings, the page says it is still filling up. */
export const FILLING_UP_AT = 500;
export const MAX_LOOK_RESULTS = 12;
/** Photos embedded a tick, and at most a day (2,000 × at most $0.0012 = $2.40). */
export const EMBED_BATCH = 20;
export const EMBED_DAILY_CAP = 2000;

const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'] as const;

/** The port packages/ai fills: photos as documents, the buyer's words as a query. Each call metered there. */
export type ImageEmbedder = {
  model: string;
  embedImages(urls: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

/** Is the embedding batch switched on? Only an explicit `VISUAL_EMBED_ENABLED=on` (or 1/true) — off otherwise. */
export function visualEmbedEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ['on', '1', 'true'].includes((env.VISUAL_EMBED_ENABLED ?? '').trim().toLowerCase());
}

const words = z
  .string()
  .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(3, 'Describe the look in a few words').max(200, 'Keep it under 200 characters'));

export const lookAskFields = z
  .object({
    words: words.optional(),
    photoId: z.string().uuid().optional(),
    channel: z.enum(['sale', 'rent']).default('sale'),
    suburbs: z.array(z.string().trim().min(2).max(60)).max(8).default([]),
    state: z.enum(STATES).optional(),
    priceTo: z.number().int().positive().max(100_000_000).optional(),
    bedrooms: z.number().int().min(0).max(10).optional(),
    propertyType: z.string().trim().min(2).max(40).optional(),
  })
  .strict();
export const lookAskSchema = lookAskFields.refine((v) => Boolean(v.words) !== Boolean(v.photoId), { message: 'Give words or a photo, not both' });
export type LookAsk = z.infer<typeof lookAskSchema>;

export type LookHome = {
  listingId: string;
  address: string;
  suburb: string;
  state: string;
  price: string;
  bedrooms: number | null;
  propertyType: string | null;
  photo: { mediaId: string; url: string; caption: string | null };
};

export type LookResult =
  | { status: 'found'; basis: 'words' | 'photo'; homes: LookHome[]; searchable: number }
  | { status: 'filling_up'; photos: number; searchable: number; threshold: number }
  | { status: 'photo_not_found' }
  | { status: 'unavailable' };

const L_BEDS = factSql('bedrooms', 'l', 'p');
const L_TYPE = factSql('property_type', 'l', 'p');
const STREET = sql`nullif(trim(concat(case when p.unit is not null then p.unit || '/' end, concat_ws(' ', p.street_number, p.street))), '')`;
const TOP_PRICE = sql`case when l.channel = 'rent' then l.rent_pw else coalesce(l.price_to, l.price_from) end`;
const PUBLIC = sql`l.status = ${PUBLIC_STATUS} and l.agency_id not in ${SUSPENDED_AGENCY_IDS}`;
const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

/** A vector as pgvector's text form, or null when it is not 1024 finite numbers. Pure. */
export function vectorLiteral(v: unknown): string | null {
  if (!Array.isArray(v) || v.length !== VISUAL_DIMENSIONS || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  return `[${v.join(',')}]`;
}

/** Photos on public listings, and how many of them are searchable now. One read. */
export async function visualCounts(db: DbOrTx): Promise<{ photos: number; searchable: number }> {
  const rows = (await db.execute(sql`
    select count(*)::int as photos, count(e.media_id)::int as searchable
    from media m
    join listing l on l.id = m.listing_id
    left join media_embedding e on e.media_id = m.id and e.model = ${VISUAL_MODEL}
    where m.kind = 'photo' and ${PUBLIC}`)) as unknown as { photos: number; searchable: number }[];
  return { photos: Number(rows[0]?.photos ?? 0), searchable: Number(rows[0]?.searchable ?? 0) };
}

/** A public photo's own vector, for "more like this photo". One read; null when it is not public or not embedded. */
async function photoVector(db: DbOrTx, mediaId: string): Promise<{ vector: string; listingId: string } | null> {
  const rows = (await db.execute(sql`
    select e.embedding::text as vector, l.id as listing_id
    from media_embedding e
    join media m on m.id = e.media_id and m.kind = 'photo'
    join listing l on l.id = e.listing_id
    where e.media_id = ${mediaId} and e.model = ${VISUAL_MODEL} and ${PUBLIC}
    limit 1`)) as unknown as { vector: string; listing_id: string }[];
  return rows[0] ? { vector: rows[0].vector, listingId: rows[0].listing_id } : null;
}

type Row = {
  listing_id: string;
  media_id: string;
  storage_key: string;
  caption: string | null;
  street: string | null;
  suburb: string;
  state: string;
  channel: string;
  price_display: string | null;
  price_from: string | null;
  price_to: string | null;
  rent_pw: string | null;
  bedrooms: number | string | null;
  property_type: string | null;
};

/** The ranked read: the filters, then each listing's closest photo, closest first. One read. */
async function nearest(db: DbOrTx, vector: string, ask: LookAsk, excludeListingId: string | null): Promise<Row[]> {
  const filters: SQL[] = [PUBLIC, sql`m.kind = 'photo'`, sql`e.model = ${VISUAL_MODEL}`, sql`l.channel = ${ask.channel}`];
  if (ask.suburbs.length) filters.push(sql`lower(p.suburb) in ${ask.suburbs.map((s) => s.toLowerCase())}`);
  if (ask.state) filters.push(sql`p.state = ${ask.state}`);
  if (ask.priceTo !== undefined) filters.push(sql`(${TOP_PRICE} is null or ${TOP_PRICE} <= ${ask.priceTo})`);
  if (ask.bedrooms !== undefined) filters.push(sql`${L_BEDS} >= ${ask.bedrooms}`);
  if (ask.propertyType) filters.push(sql`lower(${L_TYPE}) = ${ask.propertyType.toLowerCase()}`);
  if (excludeListingId) filters.push(sql`l.id <> ${excludeListingId}`);
  return (await db.execute(sql`
    with q as (select ${vector}::vector as v),
    best as (
      select distinct on (l.id)
             l.id as listing_id, m.id as media_id, m.storage_key, m.caption, ${STREET} as street, p.suburb, p.state,
             l.channel::text as channel, l.price_display, l.price_from, l.price_to, l.rent_pw,
             ${L_BEDS} as bedrooms, ${L_TYPE} as property_type, e.embedding <=> q.v as distance
      from media_embedding e
      cross join q
      join media m on m.id = e.media_id
      join listing l on l.id = e.listing_id
      join property p on p.id = l.property_id
      where ${sql.join(filters, sql` and `)}
      order by l.id, distance, m.id
    )
    select listing_id, media_id, storage_key, caption, street, suburb, state, channel, price_display, price_from, price_to,
           rent_pw, bedrooms, property_type
    from best order by distance, listing_id
    limit ${MAX_LOOK_RESULTS}`)) as unknown as Row[];
}

function card(r: Row): LookHome | null {
  const url = mediaUrl(r.storage_key);
  if (!url) return null;
  const price = r.channel === 'rent' ? r.price_display?.trim() || (r.rent_pw === null ? 'no price shown' : `${AUD.format(Number(r.rent_pw))} a week`) : priceText(r.price_display, r.price_from, r.price_to);
  return {
    listingId: r.listing_id,
    address: [r.street?.trim(), r.suburb].filter(Boolean).join(', '),
    suburb: r.suburb,
    state: r.state,
    price,
    bedrooms: r.bedrooms === null ? null : Number(r.bedrooms),
    propertyType: r.property_type,
    photo: { mediaId: r.media_id, url, caption: r.caption },
  };
}

/**
 * Homes that look like the buyer's words or one public photo (decisions 9–11). The words become a query vector
 * through the embedder — a network call, before any transaction (there is none here); a photo uses its stored vector
 * and costs nothing. `minPhotos` is a test seam; the site uses FILLING_UP_AT.
 */
export async function homesThatLookLike(db: DbOrTx, ask: LookAsk, deps: { embedder: ImageEmbedder | null; minPhotos?: number }): Promise<LookResult> {
  const counts = await visualCounts(db);
  const threshold = deps.minPhotos ?? FILLING_UP_AT;
  if (counts.searchable < threshold) return { status: 'filling_up', photos: counts.photos, searchable: counts.searchable, threshold };
  let vector: string | null;
  let exclude: string | null = null;
  if (ask.photoId) {
    const own = await photoVector(db, ask.photoId);
    if (!own) return { status: 'photo_not_found' };
    vector = own.vector;
    exclude = own.listingId;
  } else {
    if (!deps.embedder) return { status: 'unavailable' };
    vector = vectorLiteral(await deps.embedder.embedQuery(ask.words!).catch(() => null));
    if (!vector) return { status: 'unavailable' };
  }
  const homes = (await nearest(db, vector, ask, exclude)).flatMap((r) => card(r) ?? []);
  return { status: 'found', basis: ask.photoId ? 'photo' : 'words', homes, searchable: counts.searchable };
}

/**
 * One tick of the embedding batch (decision 8, on the alerts cron). Always first: vectors of listings no longer public
 * are deleted (decision 10 — a vector exists only while its listing is public). Then, only when switched on and under
 * the daily cap, the oldest public photos with no vector are embedded — the network call before the write, and a
 * failed call leaves them for the next tick.
 */
export async function embedPhotoBatch(
  db: Db,
  embedder: ImageEmbedder | null,
  opts: { enabled: boolean; batch?: number; dailyCap?: number },
): Promise<{ removed: number; embedded: number; skipped: null | 'off' | 'no_embedder' | 'daily_cap' | 'failed' }> {
  const gone = (await db.execute(sql`
    delete from media_embedding e using listing l
    where l.id = e.listing_id and not (${PUBLIC})
    returning e.media_id`)) as unknown as unknown[];
  const removed = gone.length;
  if (!opts.enabled) return { removed, embedded: 0, skipped: 'off' };
  if (!embedder) return { removed, embedded: 0, skipped: 'no_embedder' };
  const cap = opts.dailyCap ?? EMBED_DAILY_CAP;
  const [today] = (await db.execute(sql`select count(*)::int as n from media_embedding where embedded_at > now() - interval '24 hours'`)) as unknown as { n: number }[];
  const room = Math.min(opts.batch ?? EMBED_BATCH, cap - Number(today?.n ?? 0));
  if (room <= 0) return { removed, embedded: 0, skipped: 'daily_cap' };
  const due = (await db.execute(sql`
    select m.id as media_id, m.listing_id, m.storage_key
    from media m
    join listing l on l.id = m.listing_id
    left join media_embedding e on e.media_id = m.id and e.model = ${VISUAL_MODEL}
    where m.kind = 'photo' and ${PUBLIC} and e.media_id is null
    order by m.created_at, m.id
    limit ${room}`)) as unknown as { media_id: string; listing_id: string; storage_key: string }[];
  const photos = due.flatMap((d) => {
    const url = mediaUrl(d.storage_key);
    return url ? [{ ...d, url }] : [];
  });
  if (!photos.length) return { removed, embedded: 0, skipped: null };
  const vectors = await embedder.embedImages(photos.map((p) => p.url)).catch(() => null);
  if (!vectors || vectors.length !== photos.length) return { removed, embedded: 0, skipped: 'failed' };
  const values = photos.flatMap((p, i) => {
    const v = vectorLiteral(vectors[i]);
    return v ? [sql`(${p.media_id}::uuid, ${p.listing_id}::uuid, ${VISUAL_MODEL}, ${v}::vector)`] : [];
  });
  if (!values.length) return { removed, embedded: 0, skipped: 'failed' };
  await db.execute(sql`
    insert into media_embedding (media_id, listing_id, model, embedding)
    values ${sql.join(values, sql`, `)}
    on conflict (media_id) do update set model = excluded.model, embedding = excluded.embedding, embedded_at = now()`);
  return { removed, embedded: values.length, skipped: null };
}

/** What the guide reads (decision 12): the cards' facts and the rules. No distance, no score. Pure. */
export function lookToolResult(result: LookResult, page: string) {
  const rules = 'These homes are ordered by how alike their photos look, within the filters. Say that, and link the page. Never say a home is better, nicer, newer or in better condition, never give a score or a percentage, and never describe what a photo shows beyond the words the visitor used.';
  if (result.status === 'filling_up') return { found: false, note: `Search by look is still filling up: ${result.searchable} searchable photos on public listings, and it starts at ${result.threshold}. Say so and suggest Similar homes on a listing, or a search by suburb and features.`, page };
  if (result.status === 'photo_not_found') return { found: false, note: 'That photo is not on a public listing, or has not been indexed yet. Say so.', page };
  if (result.status === 'unavailable') return { found: false, note: 'Search by look could not run just now. Say so and suggest trying again later.', page };
  return {
    found: result.homes.length > 0,
    basis: result.basis,
    homes: result.homes.map((h) => ({ listingId: h.listingId, address: h.address, price: h.price, bedrooms: h.bedrooms, propertyType: h.propertyType, matchedPhoto: h.photo.caption ?? 'a listing photo' })),
    page,
    rules,
  };
}

/** The page for an ask: /look with its words or photo and its filters. Pure. */
export function lookPageHref(ask: LookAsk): string {
  const q = new URLSearchParams();
  if (ask.words) q.set('words', ask.words);
  if (ask.photoId) q.set('photo', ask.photoId);
  if (ask.channel !== 'sale') q.set('channel', ask.channel);
  if (ask.suburbs.length) q.set('suburb', ask.suburbs.join(','));
  if (ask.state) q.set('state', ask.state);
  if (ask.priceTo !== undefined) q.set('price', String(ask.priceTo));
  if (ask.bedrooms !== undefined) q.set('beds', String(ask.bedrooms));
  if (ask.propertyType) q.set('type', ask.propertyType);
  return `/look?${q}`;
}

/** /look's query string → an ask, or null when it asks nothing valid (the page then shows the empty form). Pure. */
export function lookAskFromParams(raw: Record<string, string | string[] | undefined>): LookAsk | null {
  const one = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string).trim() : '');
  const int = (k: string) => (/^\d{1,9}$/.test(one(k)) ? Number(one(k)) : undefined);
  const candidate = {
    ...(one('words') ? { words: one('words') } : {}),
    ...(one('photo') ? { photoId: one('photo') } : {}),
    channel: one('channel') === 'rent' ? 'rent' : 'sale',
    suburbs: one('suburb') ? one('suburb').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8) : [],
    ...(one('state') ? { state: one('state').toUpperCase() } : {}),
    ...(int('price') ? { priceTo: int('price') } : {}),
    ...(int('beds') !== undefined ? { bedrooms: int('beds') } : {}),
    ...(one('type') ? { propertyType: one('type') } : {}),
  };
  const parsed = lookAskSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
