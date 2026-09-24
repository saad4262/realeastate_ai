import { config } from 'dotenv';
import { resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, listing, membership, property, type Db } from '@repo/db';
import {
  getPublicListing,
  listingAgentCards,
  listingDraftSchema,
  propertyTimeline,
  liveSuburbs,
  propertyDraftSchema,
  searchPublicListings,
  searchPublicListingsPage,
  type PublicListingSummary,
} from '@repo/core/listings';
import {
  isGeoProviderConfigured,
  resolvePlace,
  reverseGeocode,
  suggestPlaces,
} from '@repo/core/geo';
import { createEnquiry } from '@repo/core/leads';
import type { ChatTurnResult } from '@repo/ai/chat-events';
import { assert, check, group, note, report, skip } from './runner';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

const WEB = process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000';
const AGENCY = process.env.NEXT_PUBLIC_AGENCY_URL ?? 'http://agency.lvh.me:3001';
const AGENT = process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://agents.lvh.me:3001';

/** Is a dev server answering? Checked once so 20 checks do not each time out. */
async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function http(url: string): Promise<Response> {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
}

/**
 * A chat turn, through the route's buffered mode.
 *
 * Accept: application/json drains the same generator the NDJSON stream does,
 * so this exercises the shipping pipeline rather than a second copy of it —
 * and the streaming parser never has to be reimplemented here.
 */
async function chat(body: unknown): Promise<ChatTurnResult> {
  const res = await fetch(`${WEB}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    // A three-round turn is slower than any other check here.
    signal: AbortSignal.timeout(120_000),
  });

  // The limiter is 10 a minute and this group spends several. Hitting it means
  // the limiter works, not that the guide is broken — and a run that goes red
  // for that would teach everyone to ignore the output.
  if (res.status === 429) skip('rate limited — rerun in a minute');

  const body_ = (await res.json().catch(() => null)) as ChatTurnResult | { message?: string } | null;
  assert(res.status === 200, `HTTP ${res.status}: ${JSON.stringify(body_)?.slice(0, 160)}`);
  const turn = body_ as ChatTurnResult;
  assert(Array.isArray(turn?.results), `not a chat turn: ${JSON.stringify(body_)?.slice(0, 160)}`);
  assert(!turn.error, `the guide errored: ${turn.error?.message}`);
  return turn;
}

/** The one search a turn should have run, or a readable failure. */
function onlySearch(turn: ChatTurnResult) {
  const search = turn.results[turn.results.length - 1];
  assert(search !== undefined, `the guide never searched. It said: "${turn.text.slice(0, 120)}"`);
  return search;
}

/** Every dollar figure in a string, so an answer can be checked against its source. */
function dollarFigures(text: string): string[] {
  return (
    [...text.matchAll(/\$\d[\d,]*(?:\.\d+)?/g)]
      .map((m) => m[0])
      // The pattern has to allow a comma inside a figure, which means it also
      // swallows the sentence's own comma in "...$332,432, with 23 bed".
      // That trailing punctuation is not part of the number.
      .map((f) => f.replace(/[.,]+$/, ''))
  );
}

/**
 * A figure reduced to its digits, so a price can be compared however it was
 * written.
 *
 * The model is handed price_display verbatim and formats it for reading, so a
 * row storing "9320334343324" comes back as "$9,320,334,343,324". Those are
 * the same number and must compare equal, or quoting the database faithfully
 * looks exactly like inventing a price.
 */
function figureDigits(figure: string): string {
  return figure.replace(/[^\d.]/g, '');
}

/** The number in "3 results" on the search page, read from the rendered HTML. */
async function resultCount(query: string): Promise<number> {
  const res = await http(`${WEB}/search?${query}`);
  assert(res.ok, `search returned HTTP ${res.status}`);
  const html = await res.text();
  const m = /([0-9]+) results?\s+—/.exec(html);
  assert(m?.[1] !== undefined, 'could not find a result count on the page');
  return Number(m[1]);
}

/**
 * Every stylesheet a page links, concatenated.
 *
 * Used to answer "is this page actually styled", which turns out to be a
 * question nothing else here could ask.
 */
async function servedCss(path: string): Promise<{ html: string; css: string }> {
  const res = await http(`${WEB}${path}`);
  assert(res.ok, `${path} returned HTTP ${res.status}`);
  const html = await res.text();

  const hrefs = [...html.matchAll(/href="([^"]*\.css[^"]*)"/g)].map((m) => m[1] as string);
  const sheets = await Promise.all(
    [...new Set(hrefs)].map(async (href) => {
      const sheet = await http(href.startsWith('http') ? href : `${WEB}${href}`);
      return sheet.ok ? sheet.text() : '';
    }),
  );
  return { html, css: sheets.join('\n') };
}

/**
 * Why the live AI group is being skipped — the flag, or the key.
 *
 * Two different situations that must not read the same: "you chose not to
 * spend money" is the normal state, and "you asked to and cannot" is a
 * misconfiguration.
 */
function aiSkipReason(liveAi: boolean): string {
  return liveAi
    ? 'SMOKE_LIVE_AI=1 but no ANTHROPIC_API_KEY'
    : 'live AI is opt-in — run `pnpm smoke:ai` to include it (costs ~US$0.02)';
}

const suburbsOf = (rows: PublicListingSummary[]) => [...new Set(rows.map((r) => r.suburb))];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stdout.write('DATABASE_URL is not set — nothing can be checked.\n');
    process.exit(1);
  }
  const db: Db = getDb(url);

  // ---------------------------------------------------------------- schema --
  group('Database & migrations');

  await check('connects', async () => {
    const [row] = await db.execute<{ now: Date }>(sql`select now() as now`);
    assert(row, 'no response');
    return 'reachable';
  });

  await check('property.geom exists and is generated by Postgres', async () => {
    const rows = await db.execute<{ is_generated: string }>(
      sql`select is_generated from information_schema.columns
          where table_name = 'property' and column_name = 'geom'`,
    );
    const first = rows[0];
    assert(first, 'property.geom is missing — migration 0006 has not run');
    assert(
      first.is_generated === 'ALWAYS',
      `geom is not generated (${first.is_generated}); something is writing it by hand`,
    );
    return 'GENERATED ALWAYS … STORED';
  });

  await check('geom has a GiST index', async () => {
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'property_geom_idx'`,
    );
    const first = rows[0];
    assert(first, 'property_geom_idx is missing — radius search will table-scan');
    assert(/gist/i.test(first.indexdef), 'index exists but is not GiST');
    return 'property_geom_idx';
  });

  await check('PostGIS answers a distance question', async () => {
    const rows = await db.execute<{ km: number }>(
      sql`select round((ST_Distance(
            ST_SetSRID(ST_MakePoint(151.2743, -33.8908), 4326)::geography,
            ST_SetSRID(ST_MakePoint(151.2093, -33.8688), 4326)::geography) / 1000)::numeric, 1) as km`,
    );
    const km = Number(rows[0]?.km);
    assert(km > 5 && km < 8, `Bondi→CBD came back as ${km} km, which is wrong`);
    return `Bondi Beach → Sydney CBD = ${km} km`;
  });

  await check('place_cache exists', async () => {
    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from place_cache`);
    return `${rows[0]?.n ?? 0} cached lookups`;
  });

  group('Database health');

  await check('every index the queries rely on is present', async () => {
    const wanted = [
      ['property_geom_idx', 'radius search — without it every search scans the table'],
      ['property_suburb_lower_idx', 'suburb search'],
      ['property_postcode_idx', 'postcode search'],
      ['listing_status_channel_idx', 'every public search narrows on these first'],
      ['place_cache_lookup_key_idx', 'geocode cache lookups'],
    ] as const;

    const rows = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public'`,
    );
    const have = new Set(rows.map((r) => r.indexname));
    const missing = wanted.filter(([name]) => !have.has(name));
    assert(
      missing.length === 0,
      `missing: ${missing.map(([n, why]) => `${n} (${why})`).join(', ')}`,
    );
    return `${wanted.length} present`;
  });

  await check('no index is marked invalid', async () => {
    // A failed CREATE INDEX CONCURRENTLY leaves the index in place and unused.
    // Queries keep working and quietly stop being fast.
    const rows = await db.execute<{ indexrelid: string }>(
      sql`select i.indexrelid::regclass::text as indexrelid
          from pg_index i where not i.indisvalid`,
    );
    assert(rows.length === 0, `invalid: ${rows.map((r) => r.indexrelid).join(', ')}`);
    return 'all valid';
  });

  await check('the radius search plan uses the spatial index', async () => {
    // Postgres reasonably prefers a sequential scan on a tiny table, so this
    // asks the planner to cost the index path and only fails when the index
    // cannot be used at all — a broken expression or a dropped column.
    const plan = await db.execute<{ 'QUERY PLAN': string }>(
      sql`explain (costs off)
          select p.id from property p
          where ST_DWithin(p.geom,
            ST_SetSRID(ST_MakePoint(145.4819, -38.0777), 4326)::geography, 10000)`,
    );
    const text = plan.map((r) => r['QUERY PLAN']).join(' ');
    assert(/geom|Index|Seq Scan/.test(text), `unexpected plan: ${text}`);
    return text.includes('Index') ? 'index scan' : 'seq scan (table is small — expected)';
  });

  await check('geocoded properties all have a usable point', async () => {
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from property where latitude is not null and geom is null`,
    );
    assert((rows[0]?.n ?? 0) === 0, `${rows[0]?.n} rows have lat/lng but no geom`);
    return 'lat/lng and geom agree';
  });

  await check('no listing is left without an agent', async () => {
    // The state a non-transactional create used to leave behind: a listing
    // nobody can be contacted about. If this is ever non-zero, something wrote
    // outside a transaction.
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from listing l
          where not exists (select 1 from listing_agent la where la.listing_id = l.id)`,
    );
    assert((rows[0]?.n ?? 0) === 0, `${rows[0]?.n} listing(s) have no agent — a partial write`);
    return 'every listing has one';
  });

  await check('every live listing still satisfies the listing contract', async () => {
    /**
     * The schema the console form enforces, asked of what is actually in the
     * database — not a second copy of the rules that can drift from it.
     *
     * A row only has to pass on the way in. Rules get tightened afterwards,
     * and rows written before a rule existed stay exactly as they were: this
     * database held three live listings with headlines "dfs", "dfsdsf" and
     * "jdsfjdfjl", display prices of bare digits, and one property claiming 23
     * bedrooms and 32 bathrooms. Nothing was broken, so nothing complained.
     * This is what complains.
     *
     * Live only, deliberately. A draft is work in progress and may legitimately
     * be half-filled; live means a buyer can see it.
     */
    const rows = await db.execute<{
      id: string;
      channel: string;
      headline: string | null;
      price_display: string | null;
      price_from: string | null;
      price_to: string | null;
      rent_pw: string | null;
      bedrooms: number | null;
      bathrooms: string | null;
      car_spaces: number | null;
      suburb: string;
      state: string;
      postcode: string;
    }>(
      sql`select l.id, l.channel, l.headline, l.price_display, l.price_from, l.price_to,
                 l.rent_pw, p.bedrooms, p.bathrooms, p.car_spaces, p.suburb, p.state, p.postcode
          from listing l join property p on p.id = l.property_id
          where l.status = 'live'`,
    );

    const n = (v: string | null) => (v === null ? undefined : Number(v));
    const bad: string[] = [];

    for (const r of rows) {
      const listingResult = listingDraftSchema.safeParse({
        channel: r.channel,
        headline: r.headline ?? '',
        priceDisplay: r.price_display ?? undefined,
        priceFrom: n(r.price_from),
        priceTo: n(r.price_to),
        rentPw: n(r.rent_pw),
      });
      const propertyResult = propertyDraftSchema.safeParse({
        suburb: r.suburb,
        state: r.state,
        postcode: r.postcode,
        bedrooms: r.bedrooms ?? undefined,
        bathrooms: n(r.bathrooms),
        carSpaces: r.car_spaces ?? undefined,
      });

      const issues = [
        ...(listingResult.success ? [] : listingResult.error.issues),
        ...(propertyResult.success ? [] : propertyResult.error.issues),
      ];
      if (issues.length) {
        bad.push(`${r.id.slice(0, 8)} (${r.suburb}): ${issues.map((i) => i.message).join('; ')}`);
      }
    }

    assert(
      bad.length === 0,
      `${bad.length} of ${rows.length} live listing(s) would be refused today:\n    ${bad.join('\n    ')}`,
    );
    return `${rows.length} live listing(s), all valid`;
  });

  await check("a property's public history never leaks an unpublished listing", async () => {
    /**
     * The listing page shows what has happened at an address, built by
     * selecting every listing that shares its property_id — because a property
     * outlives its listings (#1). That is also how an agency's unpublished
     * pipeline would reach the public: their drafts sit on the same property.
     *
     * The unit test can only assert the status list is right. Only this can
     * assert the QUERY honours it, against a database that actually holds
     * drafts.
     */
    const props = await db.execute<{ id: string }>(
      sql`select distinct property_id as id from listing`,
    );
    if (props.length === 0) skip('no listings to check');

    const forbidden = new Set(['draft', 'pending', 'withdrawn']);
    const leaked: string[] = [];
    let entries = 0;

    for (const p of props) {
      for (const entry of await propertyTimeline(db, p.id)) {
        entries++;
        if (forbidden.has(entry.status)) {
          leaked.push(`${entry.listingId.slice(0, 8)} is ${entry.status}`);
        }
      }
    }

    assert(leaked.length === 0, `timeline exposed: ${leaked.join(', ')}`);
    return `${props.length} propert(ies), ${entries} public entries, no drafts`;
  });

  await check('a public listing never exposes an agent email', async () => {
    // listing_agent carries snapshot_email and the public read deliberately
    // does not select it. A phone on a property ad is the convention; an email
    // rendered into a public page is harvested within days.
    const rows = await db.execute<{ id: string }>(
      sql`select id from listing where status = 'live'`,
    );
    if (rows.length === 0) skip('nothing live');

    const leaked: string[] = [];
    let agents = 0;
    for (const r of rows) {
      for (const card of await listingAgentCards(db, r.id)) {
        agents++;
        if (JSON.stringify(card).includes('@')) leaked.push(card.name);
      }
    }

    assert(leaked.length === 0, `an email reached the public card for ${leaked.join(', ')}`);
    return `${agents} agent card(s), no addresses`;
  });

  await check('an enquiry cannot be filed against a listing that is not live', async () => {
    /**
     * The public enquiry form has no actor to ask can() about, so its whole
     * authorisation story is what the server decides rather than accepts: the
     * agency comes from the listing, and the listing has to be live.
     *
     * The unit test cannot check the second half — its fake ignores the WHERE
     * clause, and dropping the status filter leaves it green. This is the only
     * place that filter is actually exercised.
     *
     * Accepting an enquiry on a draft would also confirm, to anyone guessing
     * ids, that a draft with that id exists.
     */
    const enquiry = {
      name: 'Smoke Check',
      email: 'smoke@example.invalid',
      message: 'This should never be written to the database.',
    };

    // An id that is not a listing at all.
    let refusedUnknown = false;
    try {
      await createEnquiry(db, '00000000-0000-4000-8000-000000000000', enquiry);
    } catch {
      refusedUnknown = true;
    }
    assert(refusedUnknown, 'an enquiry was accepted for an id that is not a listing');

    // And a real listing that is not live, when the database has one. Skips
    // rather than passes when it does not, so this never reports a guard it
    // did not exercise.
    const [hidden] = await db.execute<{ id: string; status: string }>(
      sql`select id, status from listing where status <> 'live' limit 1`,
    );
    if (!hidden) {
      return 'unknown id refused (no non-live listing present to test the status filter)';
    }

    let refusedHidden = false;
    try {
      await createEnquiry(db, hidden.id, enquiry);
    } catch {
      refusedHidden = true;
    }
    assert(refusedHidden, `an enquiry was accepted against a ${hidden.status} listing`);

    const [leaked] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from lead where email = 'smoke@example.invalid'`,
    );
    assert((leaked?.n ?? 0) === 0, `${leaked?.n} smoke lead(s) were written`);
    return `unknown id and a ${hidden.status} listing both refused`;
  });

  await check('no property is orphaned by a failed write', async () => {
    // A property with no listing is legitimate after a delete, so this only
    // reports the count rather than failing on it.
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from property p
          where not exists (select 1 from listing l where l.property_id = p.id)`,
    );
    const n = rows[0]?.n ?? 0;
    return n === 0 ? 'none' : `${n} (expected after a delete — properties outlive their ads)`;
  });

  await check('no membership is missing its agent profile', async () => {
    // The other partial write: an agent in the team list with no licence
    // details and no way to add them from the UI.
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from membership m
          where m.role in ('agent','assistant','property_manager')
            and not exists (select 1 from agent_profile p where p.user_id = m.user_id)`,
    );
    const n = rows[0]?.n ?? 0;
    assert(n === 0, `${n} agent membership(s) have no profile — a partial write`);
    return 'every agent has one';
  });

  // ------------------------------------------------------------------ keys --
  group('Credentials');

  await check('GOOGLE_MAPS_API_KEY is set', () => {
    assert(isGeoProviderConfigured(), 'not set — autocomplete falls back to our own suburbs');
    return 'set';
  });

  for (const [key, what] of [
    ['NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY', 'the visual map (pins are still stored and searched)'],
    ['R2_ACCOUNT_ID', 'photo upload'],
    ['RESEND_API_KEY', 'invite emails'],
    ['ANTHROPIC_API_KEY', 'packages/ai'],
  ] as const) {
    if (!process.env[key]?.trim()) note(key, `not set — ${what} is unavailable`);
  }

  // ------------------------------------------------------------------- geo --
  group('Geocoding (live Google)');

  const haveKey = isGeoProviderConfigured();

  await check('Places autocomplete returns Australian suburbs', async () => {
    if (!haveKey) skip('no GOOGLE_MAPS_API_KEY');
    const hits = await suggestPlaces(db, 'pakenham', { kinds: ['locality'] });
    assert(hits.length > 0, 'no suggestions at all');
    const first = hits[0];
    assert(first, 'no first suggestion');
    assert(
      /pakenham/i.test(first.label),
      `expected a Pakenham, got "${first.label}"`,
    );
    return hits.slice(0, 3).map((h) => h.label).join(', ');
  });

  await check('a picked suburb resolves to suburb + state + postcode + point', async () => {
    if (!haveKey) skip('no GOOGLE_MAPS_API_KEY');
    const place = await resolvePlace(db, 'Pakenham VIC, Australia');
    assert(place, 'did not resolve');
    assert(place.suburb, 'no suburb came back');
    assert(place.state, 'no state came back');
    assert(place.postcode, 'no postcode came back — the agent form needs all three');
    assert(
      Number.isFinite(place.latitude) && Number.isFinite(place.longitude),
      'no coordinates',
    );
    return `${place.suburb}, ${place.state} ${place.postcode} @ ${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}`;
  });

  await check('a repeated lookup is served from place_cache, not Google', async () => {
    if (!haveKey) skip('no GOOGLE_MAPS_API_KEY');
    const before = await db.execute<{ n: number }>(sql`select count(*)::int as n from place_cache`);
    await resolvePlace(db, 'Pakenham VIC, Australia');
    const after = await db.execute<{ n: number }>(sql`select count(*)::int as n from place_cache`);
    assert(
      (after[0]?.n ?? 0) === (before[0]?.n ?? 0),
      'the cache grew, so the same query was paid for twice',
    );
    return 'no new row';
  });

  await check('a dragged pin can be turned back into an address', async () => {
    if (!haveKey) skip('no GOOGLE_MAPS_API_KEY');
    // What the listing form does when an agent drops the marker: the pin is
    // useless to them as two numbers, and this is what makes it checkable.
    const place = await reverseGeocode(db, -33.894492, 151.273026);
    assert(place, 'nothing came back for a point on a named street');
    assert(place.street, 'reverse lookup gave no street');
    assert(place.suburb, 'reverse lookup gave no suburb');
    return `${place.formatted}`;
  });

  // ---------------------------------------------------------------- search --
  group('Search (live data)');

  const suburbs = await liveSuburbs(db);
  const sample = suburbs[0];

  await check('there is something live to search', () => {
    // A skip, not a failure. An empty database is a legitimate state — right
    // after a clear-listings, or on a fresh environment — and failing here
    // would make the whole run red for a reason that is not a defect.
    // The checks below skip themselves too, so the gap is visible in the output.
    if (!sample) skip('no live listings — publish one and re-run to exercise search');
    return `${suburbs.length} suburb(s): ${suburbs.join(', ')}`;
  });

  await check('an exact suburb search returns only that suburb', async () => {
    if (!sample) skip('no live listings');
    const rows = await searchPublicListings(db, { suburb: sample });
    assert(rows.length > 0, `nothing returned for ${sample}`);
    const others = suburbsOf(rows).filter((s) => s.toLowerCase() !== sample.toLowerCase());
    assert(others.length === 0, `leaked other suburbs: ${others.join(', ')}`);
    return `${rows.length} in ${sample}`;
  });

  await check('adding a radius never loses a listing from the named suburb', async () => {
    if (!sample) skip('no live listings');
    const exact = await searchPublicListings(db, { suburb: sample });
    const pinned = exact.find((r) => r.latitude !== null && r.longitude !== null);
    if (!pinned) skip(`no geocoded listing in ${sample} to centre a radius on`);

    // A deliberately tiny circle, far from most of the suburb. The suburb half
    // of the union has to carry everything the circle misses.
    const withRadius = await searchPublicListings(db, {
      suburb: sample,
      near: { lat: pinned.latitude as number, lng: pinned.longitude as number, radiusKm: 0.1 },
    });

    const lost = exact.filter((e) => !withRadius.some((w) => w.id === e.id));
    assert(
      lost.length === 0,
      `${lost.length} listing(s) in ${sample} vanished when a 0.1 km radius was added — ` +
        'suburb and radius are being ANDed instead of unioned',
    );
    return `${exact.length} kept with a 0.1 km circle`;
  });

  await check('a radius adds neighbours rather than replacing the suburb', async () => {
    if (!sample) skip('no live listings');
    const exact = await searchPublicListings(db, { suburb: sample });
    const pinned = exact.find((r) => r.latitude !== null);
    if (!pinned) skip(`no geocoded listing in ${sample}`);

    const wide = await searchPublicListings(db, {
      suburb: sample,
      near: { lat: pinned.latitude as number, lng: pinned.longitude as number, radiusKm: 50 },
    });
    assert(wide.length >= exact.length, 'a wider search returned fewer results');
    return `${exact.length} → ${wide.length} at 50 km`;
  });

  await check('a wrong state matches nothing', async () => {
    if (!sample) skip('no live listings');
    const real = await searchPublicListings(db, { suburb: sample });
    const state = real[0]?.state;
    assert(state, 'no state on the sample listing');
    const wrong = state === 'NT' ? 'WA' : 'NT';
    const rows = await searchPublicListings(db, { suburb: sample, state: wrong });
    assert(rows.length === 0, `${sample} matched in ${wrong}, so state is being ignored`);
    return `${sample} ${wrong} → 0`;
  });

  await check('drafts are invisible to the public', async () => {
    const [draft] = await db
      .select({ id: listing.id })
      .from(listing)
      .where(and(eq(listing.status, 'draft')))
      .limit(1);
    if (!draft) skip('no draft listings to check');

    const publicView = await getPublicListing(db, draft.id);
    assert(publicView === null, 'a draft listing is reachable on the public site');

    const all = await searchPublicListings(db, { limit: 100 });
    assert(!all.some((r) => r.id === draft.id), 'a draft appeared in search results');
    return 'draft hidden from both the detail page and search';
  });

  await check('rent filters read rent_pw, not the sale price columns', async () => {
    // Asserting the shape of the query rather than rows: a database with no
    // rentals would pass a row-count check no matter what the SQL said.
    const rows = await searchPublicListings(db, { channel: 'rent', priceTo: 1 });
    const wrong = rows.filter((r) => r.rentPw !== null && r.rentPw > 1);
    assert(wrong.length === 0, `${wrong.length} rental(s) above $1/wk matched a $1 cap`);
    return `${rows.length} rentals at or under $1/wk`;
  });

  await check('paging walks the result set without repeating or skipping', async () => {
    const all = await searchPublicListings(db, { limit: 100 });
    if (all.length < 2) skip('needs at least two live listings');

    // One per page, so the invariant is exercised whatever the database holds.
    const seen: string[] = [];
    let total = -1;

    for (let page = 0; page < all.length; page += 1) {
      const { rows, total: t } = await searchPublicListingsPage(db, {
        limit: 1,
        offset: page,
      });
      assert(rows.length === 1, `page ${page + 1} of ${all.length} came back empty`);

      // The total is the whole match, not the page, and does not drift as the
      // offset moves — it is count(*) over() on the same statement.
      if (total === -1) total = t;
      assert(t === total, `total changed from ${total} to ${t} at offset ${page}`);

      const id = rows[0]?.id as string;
      assert(!seen.includes(id), `listing ${id} appeared on two pages`);
      seen.push(id);
    }

    assert(
      total === all.length,
      `count(*) over() said ${total} but an unpaged search returned ${all.length}`,
    );
    assert(
      seen.length === all.length,
      `walked ${seen.length} rows one page at a time but the set holds ${all.length}`,
    );
    return `${all.length} listings, ${all.length} pages, none repeated`;
  });

  await check('every geocoded listing has a real point', async () => {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(property)
      .where(sql`latitude is not null and geom is null`);
    assert((rows[0]?.n ?? 0) === 0, `${rows[0]?.n} properties have lat/lng but no geom`);
    return 'lat/lng and geom agree';
  });

  // ------------------------------------------------------------------ http --
  group('Consumer site (HTTP)');

  const webUp = await reachable(WEB);

  await check('home page renders', async () => {
    if (!webUp) skip(`${WEB} is not answering — start it with pnpm dev`);
    const res = await http(WEB);
    assert(res.ok, `HTTP ${res.status}`);
    return `${WEB} → 200`;
  });

  await check('the pages are actually styled', async () => {
    /**
     * The check that nothing else here could make.
     *
     * apps/web is styled with Tailwind, which only emits a class it FINDS in a
     * source file — so a misconfigured PostCSS step, a content-detection miss,
     * or simply a dev server started before the config existed all produce the
     * same thing: a page that returns 200, contains every word it should, and
     * renders as unstyled blue links. Every other check here would pass.
     *
     * That is exactly what happened: a dev server running since before
     * postcss.config.mjs was added served the search results with no utilities
     * at all, through a whole phase of "does the page render" checks that only
     * ever grepped for text.
     *
     * So: take the classes the markup actually uses and assert the CSS the
     * page links defines them. It compares the page against itself, so it
     * cannot go stale as the design changes.
     */
    if (!webUp) skip('web app is not running');

    const pages = ['/', `/search?suburb=${encodeURIComponent((await liveSuburbs(db))[0] ?? 'Pakenham')}`];
    const report: string[] = [];

    for (const path of pages) {
      const { html, css } = await servedCss(path);
      assert(css.length > 0, `${path} links no stylesheet at all`);

      // A handful of utilities the redesigned pages are built out of. Read
      // from the markup rather than hard-coded, so this does not become a list
      // that has to be maintained alongside the design.
      const used = [
        ...new Set(
          [...html.matchAll(/class="([^"]*)"/g)]
            .flatMap((m) => (m[1] as string).split(/\s+/))
            .filter((c) => /^(rounded|bg|text|border|shadow|grid|flex|p|gap)-[a-z0-9-]+$/.test(c)),
        ),
      ].slice(0, 12);

      assert(used.length > 0, `${path} renders no utility classes — is it Tailwind at all?`);

      const missing = used.filter((c) => !css.includes(`.${c}`));
      assert(
        missing.length === 0,
        `${path} uses ${missing.slice(0, 5).join(', ')} and the CSS it serves defines none of them — the page is unstyled`,
      );
      /**
       * Preflight is deliberately off, so the anchor reset has to be explicit.
       *
       * Without it every card on /search underlines its price, address and
       * agency name, because the whole card is one <a> and the CSS module that
       * used to say `text-decoration: none` was deleted with the redesign.
       * "Are the utilities defined" does not catch that — the page is fully
       * styled AND wrong.
       */
      assert(
        /(^|[};])\s*a\s*\{[^}]*text-decoration:\s*none/m.test(css),
        `${path} serves no anchor reset — preflight is off, so every link is underlined`,
      );

      report.push(`${path.split('?')[0]} ${used.length} utilities`);
    }

    return report.join(' · ');
  });

  await check('/api/places suggests a suburb', async () => {
    if (!webUp) skip('web app is not running');
    const res = await http(`${WEB}/api/places?q=pakenham`);
    assert(res.ok, `HTTP ${res.status}`);
    const data = (await res.json()) as { suggestions?: { label: string }[] };
    const labels = data.suggestions?.map((s) => s.label) ?? [];
    assert(labels.length > 0, 'no suggestions returned');
    return labels.slice(0, 3).join(', ');
  });

  await check('/api/places resolves a picked suggestion', async () => {
    if (!webUp) skip('web app is not running');
    const list = await http(`${WEB}/api/places?q=pakenham`);
    const data = (await list.json()) as { suggestions?: { id: string }[] };
    const id = data.suggestions?.[0]?.id;
    assert(id, 'nothing to resolve');
    const res = await http(`${WEB}/api/places?id=${encodeURIComponent(id)}`);
    const place = ((await res.json()) as { place?: { suburb?: string; postcode?: string } }).place;
    assert(place?.suburb, 'resolved without a suburb');
    return `${place.suburb} ${place.postcode ?? ''}`.trim();
  });

  await check('the page agrees with the database', async () => {
    if (!webUp) skip('web app is not running');
    if (!sample) skip('no live listings');
    const fromDb = (await searchPublicListings(db, { suburb: sample })).length;
    const fromPage = await resultCount(`suburb=${encodeURIComponent(sample)}`);
    assert(
      fromDb === fromPage,
      `database says ${fromDb}, page says ${fromPage} — the page is dropping or inventing rows`,
    );
    return `${fromPage} results for ${sample}`;
  });

  await check('a radius in the URL widens the page, never narrows it', async () => {
    if (!webUp) skip('web app is not running');
    if (!sample) skip('no live listings');
    const rows = await searchPublicListings(db, { suburb: sample });
    const pinned = rows.find((r) => r.latitude !== null);
    if (!pinned) skip(`no geocoded listing in ${sample}`);

    const base = encodeURIComponent(sample);
    const exact = await resultCount(`suburb=${base}`);
    const wide = await resultCount(
      `suburb=${base}&lat=${pinned.latitude}&lng=${pinned.longitude}&radius=50`,
    );
    assert(wide >= exact, `${exact} without a radius but only ${wide} with 50 km`);
    return `${exact} → ${wide} at 50 km`;
  });

  await check('the radius centre comes from the suburb, not the URL', async () => {
    if (!webUp) skip('web app is not running');
    if (!sample) skip('no live listings');
    // The browser used to supply the centre, and a browser sending the wrong
    // one produced a search that was confidently wrong — a circle drawn around
    // Melbourne while the page said "within 50 km of Pakenham". Deliberately
    // absurd coordinates must change nothing.
    //
    // Three ways of writing the SAME search: no centre at all, the suburb's own
    // centre, and a centre on the other side of the country. A server that
    // resolves the suburb itself must answer all three identically.
    //
    // Comparing only "no centre" against "Sydney's centre" was not enough. Both
    // collapse to a suburb-only search when the resolution breaks, so the check
    // passed against a server that had stopped resolving anything — it was only
    // ever red on a database that happened to have listings near Sydney. The
    // suburb's real centre is the leg that cannot be faked.
    const base = `suburb=${encodeURIComponent(sample)}&radius=50`;
    const own = await resolvePlace(db, `${sample}, Australia`);
    if (!own) skip('the suburb has no resolvable centre');

    const honest = await resultCount(base);
    const withOwnCentre = await resultCount(
      `${base}&lat=${own.latitude}&lng=${own.longitude}`,
    );
    const sabotaged = await resultCount(`${base}&lat=-33.8688&lng=151.2093`);

    assert(
      honest === withOwnCentre,
      `${honest} with no centre in the URL but ${withOwnCentre} with the suburb's own — ` +
        'the server is not resolving the centre from the suburb',
    );
    assert(
      honest === sabotaged,
      `${honest} with the suburb's own centre but ${sabotaged} with Sydney's — ` +
        'the URL is still being trusted for the centre',
    );
    return `${honest} with none, its own and the wrong centre`;
  });

  await check("a picked suburb's own name does not also filter as a keyword", async () => {
    if (!webUp) skip('web app is not running');
    if (!sample) skip('no live listings');
    // Picking a suburb leaves its name in the search box. Sending that as `q`
    // as well ANDed a text filter over the location and deleted every
    // neighbouring suburb the radius had added — reported three times as a
    // broken distance filter.
    const base = `suburb=${encodeURIComponent(sample)}&radius=50`;
    const clean = await resultCount(base);
    const withLabel = await resultCount(`${base}&q=${encodeURIComponent(sample)}`);
    assert(
      clean === withLabel,
      `${clean} without the label in q but ${withLabel} with it — ` +
        "the place's own name is still being matched as a keyword",
    );
    return `${clean} either way`;
  });

  await check('a radius still applies when the URL carries no coordinates', async () => {
    if (!webUp) skip('web app is not running');
    if (!sample) skip('no live listings');
    // This used to be "a radius with no centre is ignored", which was true and
    // was the bug: a link with a radius but no lat/lng silently searched the
    // suburb alone. The server resolves the suburb's own centre now, so the
    // radius means what it says however the link was built.
    //
    // `wide >= suburbOnly` was the whole assertion here once, and equality
    // satisfies it — so this passed against a server that had stopped applying
    // the radius entirely. That is the empty-row fake this file warns about.
    // The load-bearing comparison is against the same search written WITH the
    // centre: those two must agree whatever is in the database.
    const base = `suburb=${encodeURIComponent(sample)}`;
    const centre = await resolvePlace(db, `${sample}, Australia`);
    if (!centre) skip('the suburb has no resolvable centre');

    const suburbOnly = await resultCount(base);
    const wide = await resultCount(`${base}&radius=50`);
    const wideWithCentre = await resultCount(
      `${base}&radius=50&lat=${centre.latitude}&lng=${centre.longitude}`,
    );

    assert(
      wide === wideWithCentre,
      `${wide} for a coordinate-less radius but ${wideWithCentre} when the centre is ` +
        'spelled out — the radius is being dropped rather than resolved',
    );
    assert(
      wide >= suburbOnly,
      `${suburbOnly} for the suburb but only ${wide} with a 50 km radius and no coordinates`,
    );
    return `${suburbOnly} → ${wide} at 50 km, centre resolved server-side`;
  });

  await check('a radius with no centre and no suburb widens nothing', async () => {
    if (!webUp) skip('web app is not running');
    // Nothing to draw a circle around, so the radius is dropped rather than
    // guessed at.
    const plain = await resultCount('channel=sale');
    const bogus = await resultCount('channel=sale&radius=1');
    assert(plain === bogus, 'a bare ?radius= changed the results with no place to centre on');
    return 'unchanged';
  });

  await check('the cache can be cleared from outside', async () => {
    if (!webUp) skip('web app is not running');
    const secret = process.env.REVALIDATE_SECRET?.trim();
    if (!secret) skip('REVALIDATE_SECRET is not set — the console cannot clear the public cache');

    const refused = await fetch(`${WEB}/api/revalidate`, {
      method: 'POST',
      headers: { 'x-revalidate-secret': 'not-the-secret' },
      signal: AbortSignal.timeout(10_000),
    });
    assert(refused.status === 401, `a wrong secret got HTTP ${refused.status}, not 401`);

    const allowed = await fetch(`${WEB}/api/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': secret },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    assert(allowed.ok, `the real secret got HTTP ${allowed.status}`);
    return 'wrong secret refused, right secret accepted';
  });

  await check('a cached page is fast the second time', async () => {
    if (!webUp) skip('web app is not running');
    if (!sample) skip('no live listings');
    const path = `/search?suburb=${encodeURIComponent(sample)}`;
    await fullBodyMs(path); // warm
    const ms = await fullBodyMs(path);

    // Generous: this is a dev server on a laptop. What it rules out is the
    // page going back to the database region on every view, which was ~850 ms.
    // Reading the body matters — see fullBodyMs. Timing to the first byte
    // passes this trivially on a streamed page whether it is cached or not.
    assert(ms < 400, `a warm page took ${ms} ms — the cache is not being hit`);
    return `${ms} ms warm`;
  });

  group('Speed');

  /** Median of a few runs, so one unlucky request does not decide the result. */
  /**
   * Milliseconds until the WHOLE page has arrived, not until its first byte.
   *
   * This used to stop at the response headers, and that quietly stopped
   * measuring anything the day loading.tsx was added. A streamed page flushes
   * its shell immediately whether the data underneath is cached or not, so
   * every request looked equally fast — cold 33 ms, warm 33 ms — and a lost
   * cache became undetectable by the checks written to catch it.
   *
   * The body is the part that waits on the database, so the body is what has
   * to be read.
   */
  async function fullBodyMs(path: string): Promise<number> {
    const started = Date.now();
    const res = await http(`${WEB}${path}`);
    await res.text();
    return Date.now() - started;
  }

  async function timeOf(path: string, runs = 5): Promise<number> {
    const times: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      times.push(await fullBodyMs(path));
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)] ?? 0;
  }

  /** Empties the public site's cache the way the console does. */
  async function clearCache(): Promise<boolean> {
    const secret = process.env.REVALIDATE_SECRET?.trim();
    if (!secret) return false;
    const res = await fetch(`${WEB}/api/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': secret },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  }

  /**
   * Cold against warm, rather than a millisecond budget.
   *
   * A budget is the obvious test and a bad one: the first version of this
   * allowed 400 ms, and deliberately disabling the cache took the pages from
   * 31 ms to 134 ms — four times slower and still comfortably inside it. A
   * number that passes on a fast laptop and fails on a slow one measures the
   * laptop, not the code.
   *
   * The ratio cannot be faked. If the page is cached, the request after a
   * revalidation is much slower than the ones after it, because only that one
   * goes to the database. If the caching is gone, every request costs the same
   * and the ratio collapses — which is exactly the regression worth catching.
   */
  async function assertCached(path: string, label: string) {
    if (!webUp) skip('web app is not running');
    if (!(await clearCache())) skip('REVALIDATE_SECRET is not set');

    const cold = await fullBodyMs(path);
    const warm = await timeOf(path);

    /**
     * The assertion is about the WARM request alone, not the ratio.
     *
     * The ratio was the original idea and it does not survive contact with the
     * thing it guards. Ripping the cache out entirely was measured at cold
     * 1465 ms / warm 433 ms — the warm request making a full round trip to the
     * database every time, and still comfortably passing `warm * 2 < cold`,
     * because "cold" carries one-off costs (connection setup, compilation)
     * that have nothing to do with caching. The earlier `cold - warm > 100`
     * escape hatch was wider still.
     *
     * What cannot be faked is how long a warm request takes. A cache hit is
     * 29-55 ms here; a round trip to the database region is 420-480 ms. The
     * gap is most of an order of magnitude, so the threshold sits between them
     * with room on both sides and stops measuring the laptop.
     */
    assert(
      warm < 150,
      `${label}: warm ${warm} ms (cold ${cold} ms) — a warm request this slow is ` +
        'still going to the database, so the cache is not being hit',
    );
    return `cold ${cold} ms → warm ${warm} ms`;
  }

  await check('the home page is cached', async () => assertCached('/', 'home'));

  await check('a suburb search is cached', async () => {
    if (!sample) skip('no live listings');
    return assertCached(`/search?suburb=${encodeURIComponent(sample)}`, 'suburb search');
  });

  await check('a radius search is cached, centre lookup included', async () => {
    if (!sample) skip('no live listings');
    // Resolving the centre used to add ~400 ms to every radius search. It is
    // cached for a day now, because suburb centres do not move.
    return assertCached(
      `/search?suburb=${encodeURIComponent(sample)}&radius=10`,
      'radius search',
    );
  });

  // --------------------------------------------------------------- console --
  group('Console (HTTP, signed out)');

  const consoleUp = await reachable(AGENCY);

  const guarded: [string, string][] = [
    [`${AGENCY}/live-listings`, 'agency listings'],
    [`${AGENCY}/live-listings/new`, 'agency add-listing'],
    [`${AGENCY}/live-listings/00000000-0000-0000-0000-000000000000/edit`, 'agency edit-listing'],
    [`${AGENCY}/team`, 'agency team'],
    [`${AGENT}/listings`, 'agent listings'],
    [`${AGENT}/listings/00000000-0000-0000-0000-000000000000/edit`, 'agent edit-listing'],
  ];

  /**
   * A real member's id, offered as a header, with no session cookie.
   *
   * What this proves is the end-to-end property: an unauthenticated caller
   * cannot talk their way into the console by naming a user. It is worth
   * having and it is cheap.
   *
   * What it does NOT prove is that the header strip works, and that distinction
   * was only found by breaking it. With both strips removed this check still
   * passed, because middleware redirects on `!userId` from its own getUser()
   * before any page reads a header — the strip is the second line, not the
   * first. The path where the strip is the ONLY line is NEXT_PUBLIC_UI_PREVIEW=1,
   * where middleware returns before authenticating at all; there a forged
   * header rendered a real owner's agency console, HTTP 200. Reproducing that
   * needs a second server with different env, so it lives in docs/TEST-PLAN.md
   * § G rather than here.
   */
  await check('a forged identity header cannot stand in for a session', async () => {
    if (!consoleUp) skip(`${AGENCY} is not answering`);

    const [member] = await db
      .select({ userId: membership.userId })
      .from(membership)
      .where(eq(membership.status, 'active'))
      .limit(1);
    if (!member) skip('no active membership to impersonate');

    const res = await fetch(`${AGENCY}/live-listings`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: { 'x-console-user-id': member.userId },
    });

    assert(
      res.status === 307 || res.status === 302,
      `a forged header got HTTP ${res.status} instead of being turned away`,
    );
    const location = res.headers.get('location') ?? '';
    assert(
      /login/.test(location),
      `a forged x-console-user-id was believed — landed on ${location || 'the page itself'}`,
    );
    return 'refused, sent to login';
  });

  for (const [target, name] of guarded) {
    await check(`${name} fails closed`, async () => {
      if (!consoleUp) skip(`${AGENCY} is not answering`);
      const res = await http(target);
      assert(
        res.status === 307 || res.status === 302,
        `expected a redirect to /login, got HTTP ${res.status}`,
      );
      const location = res.headers.get('location') ?? '';
      assert(/login/.test(location), `redirected somewhere other than login: ${location}`);
      return `${res.status} → login`;
    });
  }

  // ------------------------------------------------------------ chat (AI) --
  group('AI property chat');

  /**
   * Live AI checks are OPT-IN, and a key being present is not the opt-in.
   *
   * This used to read `Boolean(process.env.ANTHROPIC_API_KEY)` — so anyone
   * with a working .env.local spent real money every time they ran the suite.
   * Each run costs roughly US$0.02, `pnpm smoke` is the command you are told to
   * run after every change, and over one session that drained the account's
   * balance to zero. Six checks then went red for a billing reason rather than
   * a code one, which is the worst kind of red: it teaches you to ignore the
   * output.
   *
   * `pnpm smoke` is offline and free. `pnpm smoke:ai` is the one that spends.
   */
  const liveAi = process.env.SMOKE_LIVE_AI === '1';
  const haveAnthropic = liveAi && Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  note(
    'cost',
    'this group calls a metered model — roughly US$0.02 per run',
  );

  await check('a specific brief searches the right suburb', async () => {
    if (!webUp) skip('web app is not running');
    if (!haveAnthropic) skip(aiSkipReason(liveAi));

    // Taken from the live data so the check works against any database.
    const suburbs = await liveSuburbs(db);
    const suburb = suburbs[0];
    if (!suburb) skip('no live listings to search');

    const turn = await chat({
      message: `3 bedroom house in ${suburb} for sale under $900,000`,
    });
    const search = onlySearch(turn);

    assert(
      search.query.suburb?.toLowerCase() === suburb.toLowerCase(),
      `searched ${search.query.suburb} rather than ${suburb}`,
    );
    assert(search.query.channel === 'sale', `channel was ${search.query.channel}`);
    assert(search.query.priceTo === 900_000, `priceTo was ${search.query.priceTo}`);
    assert(search.deepLink.startsWith('/search?'), `deep link was ${search.deepLink}`);
    return `${search.matched} matches in ${suburb}`;
  });

  await check('a distance in the message becomes a radius, unasked', async () => {
    if (!webUp) skip('web app is not running');
    if (!haveAnthropic) skip(aiSkipReason(liveAi));

    const suburbs = await liveSuburbs(db);
    const suburb = suburbs[0];
    if (!suburb) skip('no live listings to search');

    // "under 30km" is a complete instruction. The guide asked whether 30 km was
    // meant, once, which is the software not listening.
    const turn = await chat({ message: `I need a house in ${suburb} under 30km` });
    const search = onlySearch(turn);

    assert(search.query.near !== undefined, 'searched without a radius');
    assert(
      search.query.near?.radiusKm === 30,
      `radius was ${search.query.near?.radiusKm}, not 30`,
    );
    // And the link keeps the suburb-not-coordinates rule the search page needs.
    assert(search.deepLink.includes('radius=30'), `deep link was ${search.deepLink}`);
    assert(!search.deepLink.includes('lat='), `deep link carried coordinates: ${search.deepLink}`);
    return `radius 30 km around ${suburb}`;
  });

  await check('every price it says came from the database', async () => {
    if (!webUp) skip('web app is not running');
    if (!haveAnthropic) skip(aiSkipReason(liveAi));

    // Non-negotiable #4, end to end. This is the only check in the suite that
    // can catch a hallucinated price, which is the worst thing this feature
    // could do — and the one failure a unit test cannot see.
    const suburbs = await liveSuburbs(db);
    const suburb = suburbs[0];
    if (!suburb) skip('no live listings to search');

    const message = `What homes are for sale in ${suburb}? Name two with their prices.`;
    const turn = await chat({ message });
    const search = onlySearch(turn);

    /**
     * What the guide was allowed to say a number from: the rows it was handed,
     * the filters the server ran, and the visitor's own words. That last one
     * matters — a guide repeating "under $900,000" back to the person who just
     * said it is quoting them, not inventing a price, and an earlier version of
     * this check failed on exactly that.
     */
    const source = JSON.stringify(search.listings) + JSON.stringify(search.query) + message;

    /**
     * Compare on digits, not on the written form.
     *
     * This used to strip the commas out of the figure but leave the dollar
     * sign on — `source.includes('$9320334343324')` — while the source JSON
     * holds `"9320334343324"` with no sign at all. So the check fired on every
     * price the guide quoted CORRECTLY from a row whose price_display has no
     * separators, and reported it as a non-negotiable #4 violation. A guard
     * that cries stop-ship at correct behaviour is worse than no guard: it
     * gets ignored, and then it is not there for the real thing.
     */
    const invented = dollarFigures(turn.text).filter((fig) => {
      const digits = figureDigits(fig);
      return digits !== '' && !source.includes(fig) && !source.includes(digits);
    });
    assert(invented.length === 0, `said ${invented.join(', ')} — not in any tool result`);
    return `${dollarFigures(turn.text).length} figure(s), all accounted for`;
  });

  await check('its link agrees with the search page', async () => {
    if (!webUp) skip('web app is not running');
    if (!haveAnthropic) skip(aiSkipReason(liveAi));

    const suburbs = await liveSuburbs(db);
    const suburb = suburbs[0];
    if (!suburb) skip('no live listings to search');

    const turn = await chat({ message: `Homes for sale in ${suburb}` });
    const search = onlySearch(turn);

    // Closes the loop between the two ways into the same data.
    const onPage = await resultCount(search.deepLink.split('?')[1] ?? '');
    assert(
      onPage >= search.listings.length,
      `chat showed ${search.listings.length} but /search found ${onPage}`,
    );
    return `chat ${search.listings.length} · /search ${onPage}`;
  });

  await check('the turn-level link is real, and opens a working search', async () => {
    if (!webUp) skip('web app is not running');
    if (!haveAnthropic) skip(aiSkipReason(liveAi));

    const suburbs = await liveSuburbs(db);
    const suburb = suburbs[0];
    if (!suburb) skip('no live listings to search');

    /**
     * The `state` frame's deepLink, which is a different link from the one on
     * the results frame: it is built from the accumulated brief rather than
     * from the last tool call, so it survives a turn where the guide asked a
     * question instead of searching.
     *
     * The server has always sent it. Until now the client dropped it on the
     * floor, so nothing — here or in a unit test — ever established that it
     * pointed anywhere. The chat renders it now, so it has to lead somewhere.
     */
    const turn = await chat({ message: `Houses for sale in ${suburb}` });
    const link = turn.state?.deepLink ?? null;

    assert(link !== null, 'the turn carried no state link at all');
    assert(link.startsWith('/search?'), `state link was ${link}`);

    /**
     * Parsed, not string-matched.
     *
     * The first version of this check compared against
     * `encodeURIComponent(suburb)` and went red on a correct link, because
     * URLSearchParams writes a space as `+` and encodeURIComponent writes it
     * as `%20`. "Nar Nar Goon North" is the suburb that caught it. Reading the
     * param back is right either way, and is what /search itself does.
     */
    const params = new URLSearchParams(link.split('?')[1] ?? '');
    assert(
      params.get('suburb')?.toLowerCase() === suburb.toLowerCase(),
      `state link carried suburb=${params.get('suburb')}, expected ${suburb}`,
    );
    // Same rule the results link follows: /search re-resolves a named suburb's
    // centre, so shipping coordinates draws the radius around the wrong point.
    assert(!link.includes('lat='), `state link carried coordinates: ${link}`);

    // And it must actually render. A well-formed path to a 500 is still a dead
    // link, and this one is now a button in the conversation.
    const onPage = await resultCount(link.split('?')[1] ?? '');
    assert(onPage > 0, `state link rendered ${onPage} results`);
    return `${link} → ${onPage} results`;
  });

  await check('it asks rather than dumping when told almost nothing', async () => {
    if (!webUp) skip('web app is not running');
    if (!haveAnthropic) skip(aiSkipReason(liveAi));

    const turn = await chat({ message: 'I want a house' });
    assert(turn.text.includes('?'), `did not ask anything: "${turn.text.slice(0, 120)}"`);

    const shown = turn.results.reduce((n, r) => n + r.listings.length, 0);
    assert(shown === 0, `showed ${shown} listings for a brief with no suburb`);
    return 'asked a question';
  });

  await check('the rate limiter holds, and costs nothing to prove', async () => {
    if (!webUp) skip('web app is not running');

    // Empty messages: the limiter runs BEFORE validation, so requests 1-10 are
    // refused as malformed and the 11th as rate-limited — without a single
    // token being spent. Testing this with real messages would cost ten turns.
    let limited = false;
    let rejected = 0;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${WEB}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ message: '' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429) limited = true;
      else if (res.status === 400 || res.status === 503) rejected += 1;
    }
    assert(limited, `11 requests and never a 429 (${rejected} were refused outright)`);
    return `${rejected} refused, then 429`;
  });

  await check('/chat renders', async () => {
    if (!webUp) skip('web app is not running');
    const res = await http(`${WEB}/chat`);
    assert(res.ok, `HTTP ${res.status}`);
    const html = await res.text();
    assert(/Property guide/i.test(html), 'the page did not render the guide');
    return 'ok';
  });

  await check('login page renders on both hosts', async () => {
    if (!consoleUp) skip('console is not running');
    for (const host of [AGENCY, AGENT]) {
      const res = await http(`${host}/login`);
      assert(res.ok, `${host}/login returned HTTP ${res.status}`);
    }
    return 'agency + agent';
  });

  process.exit(report());
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
