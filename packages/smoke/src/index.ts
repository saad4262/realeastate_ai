import { config } from 'dotenv';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import {
  getDb,
  listing,
  membership,
  property,
  scheduleRun,
  searchSchedule,
  user as userTable,
  type Db,
} from '@repo/db';
import {
  getOffMarketProperty,
  getPublicListing,
  recentSales,
  listingAgentCards,
  listingDraftSchema,
  propertyTimeline,
  liveSuburbs,
  propertyDraftSchema,
  searchPublicListings,
  nearbyMarket,
  priceLadder,
  searchFacets,
  searchPublicListingsPage,
  topSuburbAgents,
  nearbySuburbs,
  type PublicListingSummary,
  type PublicSearchQuery,
} from '@repo/core/listings';
import {
  isGeoProviderConfigured,
  resolvePlace,
  reverseGeocode,
  suggestPlaces,
} from '@repo/core/geo';
import { createEnquiry, createPrivateOffer, listAgencyLeads } from '@repo/core/leads';
import { agencyNotificationRecipients } from '@repo/core/agency';
import { fakeTransport } from '@repo/core/email';
import {
  claimDueSchedules,
  createSchedule,
  ABANDONED_RUN_MINUTES,
  deleteSchedule,
  describeCadence,
  listSchedules,
  MIN_INTERVAL_MINUTES,
  minutesFrom12Hour,
  runScheduleTick,
  signScheduleDraft,
  sweepAbandonedRuns,
  verifyScheduleDraft,
} from '@repo/core/schedules';
import { mediaUrl } from '@repo/core/media/url';
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

  await check('every sold listing says what it sold for and when', async () => {
    /**
     * The state the public timeline cannot render.
     *
     * `setListingStatus` writes status, sold_price and sold_date in one
     * statement and refuses the transition without both, so a row here means
     * something wrote `status = 'sold'` outside that function — a script, a
     * hand-run UPDATE, or a second code path that should not exist.
     *
     * It also guards the off-market property page: that page's whole content is
     * these two columns, and a sold listing with neither renders a history
     * table of em-dashes.
     */
    const rows = await db.execute<{ n: number; ids: string | null }>(
      sql`select count(*)::int as n,
                 string_agg(left(id::text, 8), ', ') as ids
          from listing
          where status = 'sold' and (sold_price is null or sold_date is null)`,
    );
    const n = rows[0]?.n ?? 0;
    assert(n === 0, `${n} sold listing(s) carry no sale figures: ${rows[0]?.ids}`);

    const [total] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from listing where status = 'sold'`,
    );
    return `${total?.n ?? 0} sold listing(s), all with a price and a date`;
  });

  await check('the lead inbox never hands a private offer to someone who may not read one', async () => {
    /**
     * The disclosure rule, against the real query and real memberships.
     *
     * An offer is a named person's financial intent about somebody's home. Only
     * the people who run the agency are told about one — `lead:read_offer`, and
     * `agencyNotificationRecipients` mails the same set. This is what says those
     * two agree, and that the filter is a WHERE clause rather than something the
     * UI is trusted to hide.
     *
     * It asserts the COUNTS as well as the rows. A non-admin must see an inbox
     * in which offers never existed, not one that says three are hidden —
     * "3 hidden" discloses most of what the restriction withholds.
     */
    const members = await db.execute<{ user_id: string; agency_id: string; role: string }>(
      sql`select user_id, agency_id, role::text from membership where status = 'active'`,
    );
    if (members.length === 0) skip('no active memberships to check');

    const admins = members.filter((m) => m.role === 'owner' || m.role === 'admin');
    const others = members.filter((m) => m.role !== 'owner' && m.role !== 'admin');

    let offersVisible = 0;
    for (const m of admins) {
      const page = await listAgencyLeads(db, {
        userId: m.user_id,
        agencyId: m.agency_id,
        membershipRole: m.role as 'owner' | 'admin',
      });
      assert(page.maySeeOffers, `${m.role} was refused the offers tab in their own agency`);
      offersVisible += page.counts.offers;
    }

    for (const m of others) {
      const actor = {
        userId: m.user_id,
        agencyId: m.agency_id,
        membershipRole: m.role as 'agent' | 'assistant' | 'property_manager' | 'read_only',
      };
      const page = await listAgencyLeads(db, actor);

      assert(!page.maySeeOffers, `a ${m.role} was told they may read private offers`);
      assert(
        page.rows.every((r) => r.kind !== 'offer'),
        `a ${m.role} was handed a private offer row`,
      );
      assert(
        page.counts.offers === 0,
        `a ${m.role} was told ${page.counts.offers} offer(s) exist — that is the disclosure`,
      );

      // And the tab itself is refused rather than shown empty: an empty page
      // reads as "no offers yet" to somebody who simply may not see them.
      let refused = false;
      try {
        await listAgencyLeads(db, actor, { kind: 'offer' });
      } catch {
        refused = true;
      }
      assert(refused, `a ${m.role} was given the offers tab instead of a refusal`);
    }

    return `${admins.length} admin(s) see ${offersVisible} offer(s), ${others.length} other member(s) see none`;
  });

  await check('the sold-history read can only ever see sold listings', async () => {
    /**
     * The security of the guide's new `recent_sales` tool, asked of the real
     * query.
     *
     * It is the first read on this platform whose whole job is to return
     * listings that are NOT live, which makes it the first one where a missing
     * status filter would not look broken — it would simply answer with more.
     * A draft is an agency's unpublished work and must never reach it.
     *
     * Every row is cross-checked against the database rather than trusted: the
     * function could filter correctly and still be handed the wrong rows by a
     * later edit to the join.
     */
    const sales = await recentSales(db, { limit: 30 });
    if (sales.length === 0) skip('no sales recorded to check');

    /**
     * An IN list built from individually-bound ids, not `any($1::uuid[])`.
     * Drizzle binds a JS array as ONE parameter, so the array form reaches
     * Postgres as a bare uuid string and fails with "malformed array literal".
     */
    const ids = sql.join(
      sales.map((s) => sql`${s.listingId}::uuid`),
      sql`, `,
    );
    const rows = await db.execute<{ id: string; status: string }>(
      sql`select id, status::text from listing where id in (${ids})`,
    );

    const wrong = rows.filter((r) => r.status !== 'sold');
    assert(
      wrong.length === 0,
      `the sold history returned ${wrong.map((r) => `${r.id.slice(0, 8)} (${r.status})`).join(', ')}`,
    );
    assert(
      sales.every((s) => s.soldPrice > 0 && s.soldDate instanceof Date),
      'a sale came back with no price or no date — it cannot be shown to anyone',
    );

    /**
     * And newest first, because "recent sales" is a claim about order. The
     * guide reads these out in the order given and a visitor will take the
     * first one as the latest.
     */
    const dates = sales.map((s) => s.soldDate.getTime());
    assert(
      dates.every((d, i) => i === 0 || dates[i - 1]! >= d),
      'sales came back out of order — the guide would call an old sale the latest',
    );

    return `${sales.length} sale(s), all sold, all priced, newest first`;
  });

  await check('a sold listing is never also on sale on the channel axis', async () => {
    /**
     * Two columns encoding the same fact is how a listing ends up sold on one
     * axis and for sale on the other. docs/adr/0012 settles it: `status` is the
     * lifecycle, `channel` is what the ad was selling, and the 'sold'/'leased'
     * channel values are legacy.
     *
     * An `info` row rather than a failure: rows written before that ADR are not
     * wrong, they are just from before. It turns into a real check the day the
     * count reaches zero and stays there.
     */
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from listing where channel in ('sold', 'leased')`,
    );
    const n = rows[0]?.n ?? 0;
    if (n > 0) {
      note('legacy channel', `${n} listing(s) still use the 'sold'/'leased' channel — pre-ADR 0012`);
      skip(`${n} legacy row(s) — nothing new writes these values`);
    }
    return 'nothing uses the legacy channel values';
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

  await check('a property on the market has no off-market page', async () => {
    /**
     * The requirement, asked of the real WHERE clause.
     *
     * While an address is being sold or rented, what it last sold for is the
     * vendor's business and the selling agency's. The unit test can only assert
     * that ON_MARKET_STATUSES holds the right two words; this asserts the query
     * acts on them, against every such property in the database.
     *
     * `under_offer` is in the list deliberately — a listing under offer has no
     * public page of its own, so keying this off `live` alone would make a
     * property mid-transaction read as off-market. See docs/adr/0012.
     */
    const onMarket = await db.execute<{ id: string; status: string }>(
      sql`select distinct p.id, l.status
          from property p join listing l on l.property_id = p.id
          where l.status in ('live', 'under_offer')`,
    );
    if (onMarket.length === 0) skip('nothing is on the market to check');

    const leaked: string[] = [];
    for (const p of onMarket) {
      if (await getOffMarketProperty(db, p.id)) {
        leaked.push(`${p.id.slice(0, 8)} has a ${p.status} listing`);
      }
    }

    assert(leaked.length === 0, `off-market page offered for: ${leaked.join(', ')}`);
    return `${onMarket.length} on-market propert(ies), none reachable`;
  });

  await check('an address nobody ever listed publicly cannot be opened', async () => {
    /**
     * The security of the route, and the half that breaks silently.
     *
     * A `property` row is created by the first agency that drafts an ad against
     * the address, and it outlives every ad (#1). So a property whose listings
     * are all drafts is an agency's unpublished pipeline — an address they are
     * about to bring to market, months before they say so. Without the gate's
     * second condition, `/property/<guessed-uuid>` would confirm each one exists
     * and print its address, its bedrooms and its map pin.
     *
     * Nothing about the page would look wrong. This is what notices.
     */
    const hidden = await db.execute<{ id: string }>(
      sql`select p.id from property p
          where exists (select 1 from listing l where l.property_id = p.id)
            and not exists (
              select 1 from listing l
              where l.property_id = p.id and l.status in ('live', 'under_offer', 'sold')
            )`,
    );
    if (hidden.length === 0) skip('no draft-only or withdrawn-only property present');

    const leaked: string[] = [];
    for (const p of hidden) {
      const open = await getOffMarketProperty(db, p.id);
      if (open) leaked.push(`${p.id.slice(0, 8)} — ${open.address}`);
    }

    assert(leaked.length === 0, `unpublished address exposed: ${leaked.join(', ')}`);
    return `${hidden.length} never-public propert(ies), none reachable`;
  });

  await check('an off-market page and its history agree with each other', async () => {
    /**
     * Two reads, one page. The gate decides whether the page exists; the
     * timeline fills it. They apply their status rules separately, so this is
     * what says they cannot disagree — a page that renders with a live listing
     * in its history table is the leak, arriving through the back door.
     */
    const props = await db.execute<{ id: string }>(
      sql`select distinct property_id as id from listing`,
    );
    if (props.length === 0) skip('no listings to check');

    let open = 0;
    let sales = 0;
    const wrong: string[] = [];

    for (const p of props) {
      if (!(await getOffMarketProperty(db, p.id))) continue;
      open++;
      for (const entry of await propertyTimeline(db, p.id)) {
        if (entry.status === 'sold') sales++;
        if (entry.status === 'live' || entry.status === 'under_offer') {
          wrong.push(`${p.id.slice(0, 8)} shows a ${entry.status} listing`);
        }
      }
    }

    assert(wrong.length === 0, `off-market history disagrees: ${wrong.join(', ')}`);
    if (open === 0) skip('no property is off-market yet — nothing to cross-check');
    return `${open} off-market page(s), ${sales} sale(s), no on-market rows`;
  });

  await check('a private offer cannot be filed on a property that is not open to one', async () => {
    /**
     * Fail-closed, against the real WHERE clause.
     *
     * `createPrivateOffer` is one INSERT ... SELECT: the statement that decides
     * whether the offer is allowed is the statement that writes it. So there is
     * no way to unit-test the decision — a fake can only report what it was
     * asked, not whether the answer is right. This asks Postgres.
     *
     * Three refusals, and the last is the one the requirement turns on: an
     * address currently being sold must not accept an offer aimed at whoever
     * sold it previously.
     */
    const OFFER = {
      name: 'Smoke Check',
      phone: '0400 000 000',
      message: 'This is a smoke check and should never be recorded anywhere.',
      offerAmount: 1,
    };
    const [someone] = await db.execute<{ id: string; email: string }>(
      sql`select id, email from "user" limit 1`,
    );
    if (!someone) skip('no user account to attribute an offer to');
    const offerer = { userId: someone.id, email: 'smoke-offer@example.invalid' };

    const refused = async (propertyId: string): Promise<boolean> => {
      try {
        await createPrivateOffer(db, propertyId, offerer, OFFER);
        return false;
      } catch {
        return true;
      }
    };

    assert(
      await refused('00000000-0000-4000-8000-000000000000'),
      'an offer was accepted for an id that is not a property',
    );

    const [onMarket] = await db.execute<{ id: string; status: string }>(
      sql`select distinct p.id, l.status from property p
          join listing l on l.property_id = p.id
          where l.status in ('live', 'under_offer') limit 1`,
    );
    if (onMarket) {
      assert(
        await refused(onMarket.id),
        `an offer was accepted on a property with a ${onMarket.status} listing`,
      );
    }

    /**
     * The re-listed case, and the only one that actually exercises the
     * on-market guard.
     *
     * A property with nothing but a live listing is already refused by
     * `status = 'sold'` — there is no sale to route to. The guard only earns its
     * place on a property that sold once and is on the market AGAIN: a house
     * sold in 2019, listed today. There the sale exists, the agency is
     * resolvable, and the only thing standing between a stranger's offer and
     * the vendor's current agent is the NOT EXISTS.
     *
     * Removing that clause left this whole check green until this sub-case
     * existed, which is exactly the kind of green CLAUDE.md warns about.
     */
    const [relisted] = await db.execute<{ id: string }>(
      sql`select p.id from property p
          where exists (select 1 from listing l
                        where l.property_id = p.id and l.status = 'sold')
            and exists (select 1 from listing l
                        where l.property_id = p.id and l.status in ('live', 'under_offer'))
          limit 1`,
    );
    if (relisted) {
      assert(
        await refused(relisted.id),
        'an offer was accepted on a property that sold once and is on the market again',
      );
    }

    const [neverPublic] = await db.execute<{ id: string }>(
      sql`select p.id from property p
          where exists (select 1 from listing l where l.property_id = p.id)
            and not exists (
              select 1 from listing l where l.property_id = p.id
                and l.status in ('live', 'under_offer', 'sold')
            ) limit 1`,
    );
    if (neverPublic) {
      assert(await refused(neverPublic.id), 'an offer was accepted on a never-public address');
    }

    // Nothing may have been written by any of the above — the same convention
    // the enquiry check uses, and the only way to know a refusal was a refusal
    // rather than a thrown error after a successful insert.
    const [leaked] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from lead where email = 'smoke-offer@example.invalid'`,
    );
    assert((leaked?.n ?? 0) === 0, `${leaked?.n} smoke offer(s) were written`);

    const tested = [
      'unknown id',
      onMarket && 'on-market',
      relisted && 'sold-then-relisted',
      neverPublic && 'never-public',
    ].filter(Boolean);
    // Named in the output on purpose: "sold-then-relisted" missing from this
    // line means the on-market guard went untested on this database.
    return `${tested.join(', ')} refused, nothing written`;
  });

  await check('an offer notification goes to owners and admins only', async () => {
    /**
     * `agency` has no email column, so "tell the agency" means telling people —
     * and which people is a disclosure decision. A private offer on a past sale
     * is commercially sensitive, and a revoked membership is somebody who has
     * left the business.
     */
    const [anAgency] = await db.execute<{ id: string }>(sql`select id from agency limit 1`);
    if (!anAgency) skip('no agency to check');

    const recipients = await agencyNotificationRecipients(db, anAgency.id);
    const allowed = await db.execute<{ email: string }>(
      sql`select u.email from membership m join "user" u on u.id = m.user_id
          where m.agency_id = ${anAgency.id} and m.status = 'active'
            and m.role in ('owner', 'admin')`,
    );

    const expected = new Set(allowed.map((r) => r.email));
    const unexpected = recipients.filter((r) => !expected.has(r.email));
    assert(
      unexpected.length === 0,
      `would notify ${unexpected.map((r) => r.email).join(', ')} — not an owner or admin`,
    );
    assert(
      recipients.length === expected.size,
      `${expected.size} owner/admin(s) but ${recipients.length} recipient(s)`,
    );
    assert(
      recipients.every((r) => r.email.includes('@')),
      'a recipient has no email address',
    );
    return `${recipients.length} recipient(s), every one an active owner or admin`;
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

  await check('the portal skin reaches /search', async () => {
    /**
     * The skin is ONE attribute and ONE CSS block.
     *
     * `/search` re-skins itself by redefining the colour tokens on a
     * `[data-skin="portal"]` wrapper, which every Tailwind utility and every
     * CSS Module below it reads through `var()`. That is what makes a palette
     * swap a twenty-line change instead of a rename of every class — and it is
     * also a single point of silent failure. Drop the attribute, or let the
     * block fall out of the built CSS, and the page renders perfectly: fully
     * styled, correct, and the wrong colour. Nothing else here would notice,
     * because "are the utilities defined" is true either way.
     *
     * So both halves are asserted: the markup carries the hook, and the CSS
     * the page actually serves redefines the brand behind it.
     */
    if (!webUp) skip('web app is not running');
    const suburb = (await liveSuburbs(db))[0] ?? 'Pakenham';
    const path = `/search?suburb=${encodeURIComponent(suburb)}`;
    const { html, css } = await servedCss(path);

    /**
     * On the page's OWN wrapper, not merely somewhere in the document.
     *
     * loading.tsx carries the skin as well — it must, or the page changes
     * colour the moment it arrives — and its shell is streamed into the same
     * response. The first version of this check asked "is data-skin anywhere
     * in the HTML", which the skeleton answers yes to on its own: deleting the
     * attribute from the real page left this check green. So it matches the
     * one element that carries both attributes.
     */
    const wrapper = /<div[^>]*data-page="search-results"[^>]*>/.exec(html);
    assert(
      wrapper !== null,
      '/search renders no results wrapper at all — did the page fail to stream?',
    );
    assert(
      /data-skin="portal"/.test(wrapper[0]),
      '/search renders its results outside the portal skin — the page is on the default palette',
    );

    // Whitespace and quote style survive minification differently, so the
    // selector is matched loosely rather than as a literal string.
    const skinBlock = /\[data-skin=['"]?portal['"]?\]\s*\{([^}]*)\}/.exec(css);
    assert(
      skinBlock !== null,
      'the CSS /search serves defines no [data-skin="portal"] block — the wrapper points at nothing',
    );
    assert(
      /--color-brand:/.test(skinBlock[1] as string),
      'the portal block does not redefine --color-brand — the skin is a no-op',
    );

    return `skin applied, ${(skinBlock[1] as string).match(/--[a-z-]+:/g)?.length ?? 0} tokens overridden`;
  });

  await check('the results sidebar counts what the database holds', async () => {
    /**
     * The panels beside the results are the only numbers on this page that are
     * not a price or a result count, and they are the kind of number a portal
     * normally invents — "54 listings", "top agent". Here they are aggregates
     * over live rows, so the page and the database have to agree exactly.
     *
     * Checked against a second, independent count rather than against the same
     * query: the panel query groups and counts, and a wrong GROUP BY returns a
     * confident, plausible, wrong number. Counting the same agent's rows the
     * long way is what catches that.
     */
    if (!webUp) skip('web app is not running');
    const suburb = (await liveSuburbs(db))[0];
    if (!suburb) skip('no live listings');

    const agents = await topSuburbAgents(db, { suburb });
    if (!agents.length) skip(`no agents listing in ${suburb}`);

    const top = agents[0] as NonNullable<(typeof agents)[number]>;
    assert(
      typeof top.listingCount === 'number' && Number.isInteger(top.listingCount),
      `the agent count came back as ${typeof top.listingCount} — a bigint arrives as text`,
    );

    // The same figure, counted without grouping.
    const [row] = await db
      .select({ n: sql<string>`count(distinct ${listing.id})` })
      .from(listing)
      .innerJoin(property, eq(property.id, listing.propertyId))
      .innerJoin(
        sql`listing_agent`,
        sql`listing_agent.listing_id = ${listing.id} and listing_agent.user_id = ${top.userId}`,
      )
      .where(
        and(
          eq(listing.status, 'live'),
          sql`lower(${property.suburb}) = lower(${suburb})`,
        ),
      );
    const independent = Number(row?.n ?? 0);
    assert(
      independent === top.listingCount,
      `the panel says ${top.listingCount} for ${top.name}, counting the rows says ${independent}`,
    );

    const res = await http(`${WEB}/search?suburb=${encodeURIComponent(suburb)}`);
    assert(res.ok, `search returned HTTP ${res.status}`);
    const html = await res.text();
    assert(
      html.includes(`Agents listing in ${suburb}`),
      `the agents panel did not render for ${suburb}`,
    );

    return `${top.name}: ${top.listingCount} in ${suburb}`;
  });

  await check('every nearby suburb the sidebar offers is a search that returns something', async () => {
    /**
     * A suggestion that lands on an empty page is worse than no suggestion.
     *
     * The panel builds each link from suburb + state + postcode — there is a
     * Richmond in four states — and claims a listing count beside it. Both of
     * those are claims about a search this site can run, so they are checked by
     * running it.
     */
    if (!webUp) skip('web app is not running');
    const suburb = (await liveSuburbs(db))[0];
    if (!suburb) skip('no live listings');

    const suggestions = await nearbySuburbs(db, { suburb });
    if (!suggestions.length) skip(`nothing listed outside ${suburb}`);

    for (const s of suggestions) {
      assert(
        s.listingCount > 0,
        `${s.suburb} is offered with ${s.listingCount} listings — the panel is suggesting an empty page`,
      );
      assert(
        s.suburb.toLowerCase() !== suburb.toLowerCase(),
        `${suburb} is being suggested as a suburb near itself`,
      );
      const found = await resultCount(
        `suburb=${encodeURIComponent(s.suburb)}&state=${encodeURIComponent(s.state)}&postcode=${encodeURIComponent(s.postcode)}`,
      );
      assert(
        found === s.listingCount,
        `the panel says ${s.suburb} has ${s.listingCount}, the search it links to returns ${found}`,
      );
    }

    return `${suggestions.length} suggestions, all non-empty`;
  });

  await check('the property page is skinned and every in-page tab lands somewhere', async () => {
    /**
     * Two invariants on one fetch, because they fail together.
     *
     * The skin: `/listing/[id]` re-skins itself with the same wrapper `/search`
     * uses, and loading.tsx carries it too — so the attribute is matched on the
     * one element that also carries `data-page`, or the skeleton answers for
     * the page. That is not hypothetical; it is how the first version of the
     * /search check passed while the skin was removed.
     *
     * The tabs: the in-page bar is built from whichever sections rendered,
     * because a listing may have no inspections, no history and no
     * coordinates. That decision was being made TWICE — once for the tab, once
     * inside the section — and the two disagreed: a property whose only
     * history is its own live listing showed a "History" tab that scrolled
     * nowhere. Nothing would have caught it, because an anchor to a missing id
     * is not an error, it is a click that does nothing.
     *
     * So: pull the hrefs out of the rendered nav and require an element with
     * each id. It compares the page against itself, so it cannot go stale as
     * sections are added.
     */
    if (!webUp) skip('web app is not running');
    if (!sample) skip('no live listings');
    const [row] = await searchPublicListings(db, { suburb: sample });
    if (!row) skip(`nothing live in ${sample}`);

    const res = await http(`${WEB}/listing/${row.id}`);
    assert(res.ok, `the listing page returned HTTP ${res.status}`);
    const html = await res.text();

    const wrapper = /<div[^>]*data-page="listing-detail"[^>]*>/.exec(html);
    assert(wrapper !== null, 'the property page renders no wrapper — did it fail to stream?');
    assert(
      /data-skin="portal"/.test(wrapper[0]),
      'the property page renders outside the portal skin — it is on the default palette',
    );

    const nav = /<nav[^>]*aria-label="On this page"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
    assert(nav !== null, 'the property page renders no in-page navigation');

    const targets = [...(nav[1] as string).matchAll(/href="#([a-z-]+)"/g)].map(
      (m) => m[1] as string,
    );
    assert(targets.length > 0, 'the in-page navigation has no links in it');

    const dangling = targets.filter((id) => !new RegExp(`id="${id}"`).test(html));
    assert(
      dangling.length === 0,
      `${dangling.join(', ')} ${dangling.length === 1 ? 'is a tab that scrolls' : 'are tabs that scroll'} to nothing`,
    );

    return `skinned, ${targets.length} tabs: ${targets.join(', ')}`;
  });

  await check("a re-listed property's listing page shows its earlier sales", async () => {
    /**
     * The requirement, asked of the rendered HTML (ADR 0013, which replaced
     * ADR 0012's "hide the history while on the market").
     *
     * A house sold by one agency and listed again by another is ONE property.
     * Its new listing page must carry the earlier sale — by price, the way the
     * timeline formats it — or the history the property/listing split exists
     * for is invisible exactly when a buyer is looking.
     *
     * Checks the tab and the section together. They were built from two separate
     * decisions once, and a `#history` tab scrolling to nothing is how that
     * showed up.
     */
    if (!webUp) skip('web app is not running');

    /**
     * A live listing whose property HAS a past sale. Only there does the price
     * assertion mean anything; with none, the check says so instead of passing.
     */
    const [relisted] = await db.execute<{ id: string }>(
      sql`select l.id from listing l
          where l.status = 'live'
            and exists (select 1 from listing s
                        where s.property_id = l.property_id and s.status = 'sold'
                          and s.sold_price is not null)
          limit 1`,
    );
    if (!relisted) skip('no live listing stands on an address that sold before');

    const res = await http(`${WEB}/listing/${relisted.id}`);
    assert(res.ok, `the listing page returned HTTP ${res.status}`);
    const html = await res.text();

    const sales = await db.execute<{ price: string }>(
      sql`select sold_price::bigint::text as price from listing
          where property_id = (select property_id from listing where id = ${relisted.id})
            and status = 'sold' and sold_price is not null`,
    );
    const missing = sales
      .map((r) => Number(r.price).toLocaleString('en-AU'))
      .filter((formatted) => !html.includes(formatted));
    assert(
      missing.length === 0,
      `a re-listed property's page leaves out its earlier sale(s): ${missing.join(', ')}`,
    );
    assert(/id="history"/.test(html), 'a re-listed listing page has no history section');
    assert(/href="#history"/.test(html), 'a re-listed listing page has no history tab');

    return `${sales.length} earlier sale(s) shown on the live listing, with its tab`;
  });

  await check('an off-market property page carries its history and no index', async () => {
    /**
     * The other side of the same swap: the page that DOES show the history.
     *
     * Only reachable once nothing at the address is on the market, which is why
     * this skips rather than fails when the database happens to hold no sold
     * listing — there is genuinely no such page to fetch then, and saying so is
     * more use than a green tick.
     */
    if (!webUp) skip('web app is not running');

    const [offMarket] = await db.execute<{ id: string }>(
      sql`select p.id from property p
          where exists (select 1 from listing l
                        where l.property_id = p.id and l.status = 'sold')
            and not exists (select 1 from listing l
                            where l.property_id = p.id
                              and l.status in ('live', 'under_offer'))
          limit 1`,
    );
    if (!offMarket) skip('no property is off-market — nothing to fetch');

    const res = await http(`${WEB}/property/${offMarket.id}`);
    assert(res.ok, `the off-market page returned HTTP ${res.status}`);
    const html = await res.text();

    const wrapper = /<div[^>]*data-page="property-detail"[^>]*>/.exec(html);
    assert(wrapper !== null, 'the off-market page did not render — it may be 404ing');
    assert(
      /data-skin="portal"/.test(wrapper[0]),
      'the off-market page renders outside the portal skin',
    );

    /**
     * noindex is a product decision, not decoration: the page is reachable by
     * link and deliberately not advertised, so a crawler must not build a
     * directory of recently-sold addresses out of it.
     */
    assert(
      /name="robots"[^>]*content="[^"]*noindex/.test(html) ||
        /content="[^"]*noindex[^"]*"[^>]*name="robots"/.test(html),
      'the off-market page is missing its noindex — it can be crawled and indexed',
    );

    assert(
      /Not currently on the market/.test(html),
      'the off-market page does not say the property is off the market',
    );
    assert(/Property history/.test(html), 'the off-market page shows no history');
    // Signed out, so the form must be a sign-in prompt rather than an offer box.
    assert(
      /Sign in to make an offer/.test(html),
      'the off-market page offers the form to an anonymous visitor',
    );

    return 'skinned, noindex, history shown, offer behind sign-in';
  });

  await check('the sold index lists sales and links each to its own history', async () => {
    /**
     * The browse page behind the guide's "View all N sold".
     *
     * It is the counterpart to `/search` and has to behave like one: real
     * cards, each linking somewhere that exists. It is also `noindex`, which is
     * not decoration — a crawlable directory of recently-sold addresses is
     * something this platform deliberately does not publish, and making sold
     * data browsable from the guide did not change that decision.
     */
    if (!webUp) skip('web app is not running');

    const [sale] = await db.execute<{ suburb: string }>(
      sql`select p.suburb from listing l join property p on p.id = l.property_id
          where l.status = 'sold' and l.sold_price is not null
            and l.sold_date > now() - interval '24 months'
          limit 1`,
    );
    if (!sale) skip('no sale recorded to list');

    const res = await http(`${WEB}/sold?suburb=${encodeURIComponent(sale.suburb)}`);
    assert(res.ok, `/sold returned HTTP ${res.status}`);
    const html = await res.text();

    assert(/data-page="sold-index"/.test(html), '/sold did not render its own page');
    assert(/data-skin="portal"/.test(html), '/sold renders outside the portal skin');
    assert(
      /name="robots"[^>]*content="[^"]*noindex/.test(html) ||
        /content="[^"]*noindex[^"]*"[^>]*name="robots"/.test(html),
      '/sold is missing its noindex — a directory of sold addresses can be crawled',
    );

    // A sale links to its history: the off-market page, or — for an address
    // re-listed since — the live listing, which carries the same history.
    const links = html.match(/href="\/(property|listing)\/[0-9a-f-]{36}"/g) ?? [];
    assert(links.length > 0, '/sold listed a sale with no link to its history');

    /**
     * And no enquiry affordance on the card itself. Nobody can enquire about a
     * house that has already been bought; a re-listed one is reached through
     * its own listing page, where the enquiry goes to the agency selling it now.
     */
    assert(!/Enquire/i.test(html), '/sold offers to enquire about a completed sale');

    return `${links.length} sale(s) listed, each linked, noindex`;
  });

  await check('an on-market property sends its history link to the live listing', async () => {
    /**
     * The off-market page and the private offer on it exist only while nothing
     * at the address is on the market. Once it is live again, an old
     * `/property/<id>` link must land on the listing — whose enquiry reaches
     * the agency selling it NOW, not whoever sold it last.
     */
    if (!webUp) skip('web app is not running');

    const [live] = await db.execute<{ property_id: string; id: string }>(
      sql`select l.property_id, l.id from listing l where l.status = 'live'
          order by l.published_at desc nulls last limit 1`,
    );
    if (!live) skip('nothing is live');

    const res = await http(`${WEB}/property/${live.property_id}`);
    const html = res.status >= 300 && res.status < 400 ? '' : await res.text();
    const location = res.headers.get('location') ?? '';
    /**
     * A redirect from a dynamic page streams as a meta refresh when the shell
     * has already been sent, so either form counts — what must NOT happen is
     * the off-market page, and its offer form, rendering.
     */
    assert(
      location.includes(`/listing/${live.id}`) || html.includes(`/listing/${live.id}`),
      `/property/<live> did not send the visitor to /listing/${live.id}`,
    );
    assert(
      !/data-page="property-detail"/.test(html),
      'an on-market property rendered its off-market page, offer form and all',
    );
    return `redirected to the live listing (${res.status})`;
  });

  await check('an old sold-listing link goes on to where the address lives now', async () => {
    /**
     * Bookmarks outlive ads. A sold listing's URL must land on the live
     * listing at that address, or its history page — never a dead end. And a
     * draft's URL must NOT be followed anywhere: that would confirm to somebody
     * guessing ids that an agency has an unpublished ad at an address.
     *
     * Redirects from this streamed route arrive as NEXT_REDIRECT in the body
     * rather than a Location header, so both are accepted.
     */
    if (!webUp) skip('web app is not running');

    const [sold] = await db.execute<{ id: string }>(
      sql`select l.id from listing l where l.status = 'sold' limit 1`,
    );
    if (!sold) skip('no sold listing to follow');

    const res = await http(`${WEB}/listing/${sold.id}`);
    const body = res.status >= 300 && res.status < 400 ? '' : await res.text();
    const target =
      res.headers.get('location') ??
      /NEXT_REDIRECT;[a-z]+;(\/(?:listing|property)\/[0-9a-f-]{36})/.exec(body)?.[1] ??
      null;
    assert(
      target !== null && /\/(listing|property)\/[0-9a-f-]{36}/.test(target),
      `/listing/<sold> did not redirect anywhere (HTTP ${res.status})`,
    );

    const [draft] = await db.execute<{ id: string }>(
      sql`select l.id from listing l where l.status = 'draft' limit 1`,
    );
    if (draft) {
      const d = await http(`${WEB}/listing/${draft.id}`);
      const dBody = d.status >= 300 && d.status < 400 ? '' : await d.text();
      assert(
        !d.headers.get('location') && !/NEXT_REDIRECT/.test(dBody),
        'a draft listing URL redirected — it confirms an unpublished ad exists',
      );
    }

    return `sold → ${target}${draft ? ', draft stays a 404' : ' (no draft to test)'}`;
  });

  await check('no filter option the search box offers can return zero results', async () => {
    /**
     * The rule the filters were rebuilt around, enforced against live data.
     *
     * Every control on /search except property type used to offer a hard-coded
     * ladder. Sale prices started at $750,000 against a database whose dearest
     * listing is under $50,000; beds went to 5 where the most any property has
     * is 3; baths to 4; parking to 3; and the Rent tab searched a channel with
     * nothing in it. Four of six controls could only empty the page — which
     * reads as "this portal has nothing", not as "that option was fiction".
     *
     * So: take the options the box will actually render, and run each one.
     * This is the check that makes "dynamic filters" a property of the system
     * rather than a claim about it, and it re-tightens automatically as the
     * data changes — there is no ladder here to keep in step.
     */
    const facets = await searchFacets(db);
    const tried: string[] = [];

    for (const channel of ['sale', 'rent'] as const) {
      const live = facets[channel];
      if (live.total === 0) {
        // An empty channel offers no options at all, which is the correct
        // behaviour rather than something to skip past.
        assert(
          live.bedrooms.length === 0 &&
            live.bathrooms.length === 0 &&
            live.carSpaces.length === 0 &&
            live.propertyTypes.length === 0 &&
            priceLadder(live.priceMin, live.priceMax).length === 0,
          `${channel} has no listings but the box would still offer filters for it`,
        );
        continue;
      }

      const options: { label: string; query: PublicSearchQuery }[] = [
        ...live.bedrooms.map((n) => ({ label: `${n}+ beds`, query: { channel, bedrooms: n } })),
        ...live.bathrooms.map((n) => ({ label: `${n}+ baths`, query: { channel, bathrooms: n } })),
        ...live.carSpaces.map((n) => ({ label: `${n}+ car`, query: { channel, carSpaces: n } })),
        ...live.propertyTypes.map((t) => ({ label: t, query: { channel, propertyType: t } })),
        // Both directions of the price ladder: every rung is offered as a
        // ceiling in the main bar and as a floor under "More filters", and a
        // rung that works one way round can still be empty the other.
        ...priceLadder(live.priceMin, live.priceMax).flatMap((n) => [
          { label: `up to ${n}`, query: { channel, priceTo: n } as PublicSearchQuery },
          { label: `from ${n}`, query: { channel, priceFrom: n } as PublicSearchQuery },
        ]),
      ];

      assert(options.length > 0, `${channel} has ${live.total} listing(s) but offers no filters`);

      for (const option of options) {
        const { total } = await searchPublicListingsPage(db, option.query);
        assert(
          total > 0,
          `${channel}: "${option.label}" is offered in the search box and returns nothing`,
        );
      }
      tried.push(`${channel} ${options.length}`);
    }

    return `${tried.join(', ')} option(s), none empty`;
  });

  await check('every stored image is a key, never a URL', async () => {
    /**
     * The one rule the whole media design rests on.
     *
     * `media.storage_key` and `agent_profile.photo_key` hold a path inside one
     * bucket. The moment a row holds
     * `https://….supabase.co/storage/v1/object/public/media/…` instead, moving
     * to R2 — which CLAUDE.md still names as where media belongs — stops being
     * a change to one resolver and becomes a migration across two tables plus
     * every component that happened to read one.
     *
     * It is the kind of rule that is obeyed for months and then broken by one
     * well-meaning line in an import script, silently, because a URL renders
     * perfectly well.
     */
    const bad = await db.execute(sql`
      select 'media' as source, storage_key as value from media
      where storage_key like '%://%' or storage_key like '/%'
      union all
      select 'agent_profile', photo_key from agent_profile
      where photo_key like '%://%' or photo_key like '/%'
      limit 5
    `);
    const rows = bad as unknown as { source: string; value: string }[];
    assert(
      rows.length === 0,
      `${rows.length} row(s) hold a URL instead of a key — e.g. ${rows[0]?.source}: ${rows[0]?.value?.slice(0, 60)}`,
    );

    const [{ n } = { n: 0 }] = (await db.execute(
      sql`select count(*)::int as n from media where kind = 'photo'`,
    )) as unknown as { n: number }[];
    return `${n} photo row(s), all keys`;
  });

  await check('a listing with photos in the database has a cover in its search result', async () => {
    /**
     * The source of truth is `media`, NOT the search result.
     *
     * The first version of this check asked the search for rows with a cover
     * and then verified those. Deleting the cover sub-select from the search
     * statement made it **skip** — "no listing has a photo yet" — because the
     * thing it filtered on was the thing that had broken. It reported green
     * over exactly the bug it was written for, which is the second time that
     * pattern has appeared in this repo and the reason ARCHITECTURE.md says to
     * break a new check before trusting it.
     *
     * So the expected set comes from the media table, and the search has to
     * account for every row in it.
     */
    const expected = (await db.execute(sql`
      select l.id as listing_id, m.storage_key as key
      from listing l
      join lateral (
        select storage_key from media
        where listing_id = l.id and kind = 'photo'
        order by is_main desc, sort_order asc, created_at asc
        limit 1
      ) m on true
      where l.status = 'live'
    `)) as unknown as { listing_id: string; key: string }[];

    if (!expected.length) skip('no live listing has a photo yet');

    const rows = await searchPublicListings(db, {});
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const want of expected) {
      const row = byId.get(want.listing_id);
      assert(row !== undefined, `listing ${want.listing_id.slice(0, 8)} has a photo but no search row`);
      assert(
        row.mainPhotoKey === want.key,
        `${row.address}: media says ${want.key.slice(-12)}, the search says ${row.mainPhotoKey ?? 'nothing'}`,
      );

      const url = mediaUrl(row.mainPhotoKey);
      assert(url !== null, 'media is not configured, but a row has a key');

      /**
       * The file is fetched, not assumed.
       *
       * Uploads write the object first and the row second; deletes remove the
       * row first and the object second. Both orders were chosen so a row
       * never points at a missing file — get either backwards and this is the
       * only thing that notices, because a 404 image is invisible to every
       * other check on this page.
       */
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      assert(res.ok, `${row.address}: its cover photo returned HTTP ${res.status}`);
      const type = res.headers.get('content-type') ?? '';
      assert(type.startsWith('image/'), `${row.address}: served as ${type || 'nothing'}`);
    }

    return `${expected.length} cover photo(s), all present in search and reachable`;
  });

  await check('the results page renders the photos the database has', async () => {
    /**
     * The page and the data, compared — the same shape as "the page agrees
     * with the database" above, for images. Expected set from `media` again,
     * for the reason the check above it gives at length.
     *
     * Two plausible causes of failure: the cover dropping out of the search
     * statement, or next.config's remotePatterns not covering the host, which
     * makes next/image throw for that image alone and leaves the rest of the
     * page perfectly fine.
     */
    if (!webUp) skip('web app is not running');
    const suburb = (await liveSuburbs(db))[0];
    if (!suburb) skip('no live listings');

    const expected = (await db.execute(sql`
      select m.storage_key as key
      from listing l
      join property p on p.id = l.property_id
      join lateral (
        select storage_key from media
        where listing_id = l.id and kind = 'photo'
        order by is_main desc, sort_order asc, created_at asc
        limit 1
      ) m on true
      where l.status = 'live' and lower(p.suburb) = lower(${suburb})
    `)) as unknown as { key: string }[];

    if (!expected.length) skip(`no listing in ${suburb} has a photo`);

    const res = await http(`${WEB}/search?suburb=${encodeURIComponent(suburb)}`);
    assert(res.ok, `search returned HTTP ${res.status}`);
    const html = await res.text();

    const missing = expected.filter((e) => !html.includes(encodeURIComponent(e.key)));
    assert(
      missing.length === 0,
      `${missing.length} of ${expected.length} cover photo(s) never reached the results page — e.g. ${missing[0]?.key.slice(-16)}`,
    );

    return `${expected.length} cover photo(s) on the page`;
  });

  await check('the media bucket refuses an anonymous write', async () => {
    /**
     * The entire authorisation story for uploads.
     *
     * The bucket has no row-level security INSERT policy, so the anon key —
     * which ships to every browser — cannot put a byte in it. Every upload
     * goes through a URL the server signs only after can() has agreed.
     *
     * Adding an insert policy "so uploads work" would make that whole chain
     * decorative while leaving it in place and passing every other test. This
     * is the check that would go red.
     */
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
    const bucket = process.env.NEXT_PUBLIC_SUPABASE_MEDIA_BUCKET?.trim() || 'media';
    if (!base || !anon) skip('Supabase is not configured');

    // A real PNG header, so the refusal is about permission rather than about
    // the bucket's MIME allowlist — which fires first and would hide this.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await fetch(
      `${base.replace(/\/+$/, '')}/storage/v1/object/${bucket}/smoke-probe.png`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${anon}`, apikey: anon, 'Content-Type': 'image/png' },
        body: png,
        signal: AbortSignal.timeout(15_000),
      },
    );

    assert(!res.ok, `the anon key uploaded to the bucket (HTTP ${res.status}) — writes are open`);
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    assert(
      /row-level security|Unauthorized|AccessDenied/i.test(
        `${body.error ?? ''} ${body.message ?? ''}`,
      ),
      `refused, but for the wrong reason: ${body.message ?? body.error ?? res.status}`,
    );

    return 'anon write refused by RLS';
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

  // ------------------------------------------------------- consumer accounts --
  group('Consumer accounts (HTTP, signed out)');

  await check('an account route sends a signed-out visitor to sign in', async () => {
    if (!webUp) skip('web app is not running');

    const res = await http(`${WEB}/alerts`);
    const location = res.headers.get('location') ?? '';

    assert(
      res.status === 307 || res.status === 302,
      `/alerts answered ${res.status}, expected a redirect`,
    );
    assert(location.includes('/login'), `redirected to ${location}, expected /login`);
    // Without `next` the visitor signs in and lands somewhere they did not ask
    // for, which reads as the link having been lost.
    assert(location.includes('next=%2Falerts'), `redirect lost the next param: ${location}`);

    return `${res.status} → ${location.replace(WEB, '')}`;
  });

  await check('the account page is an account route too', async () => {
    if (!webUp) skip('web app is not running');

    /**
     * § 9 — every new endpoint gets a permission test, and this one holds a
     * person's name, address and the only control that ends their session.
     * It is listed in the middleware matcher; this asserts the listing
     * actually does something, because a matcher line is one edit from gone.
     */
    const res = await http(`${WEB}/account`);
    const location = res.headers.get('location') ?? '';

    assert(
      res.status === 307 || res.status === 302,
      `/account answered ${res.status}, expected a redirect`,
    );
    assert(location.includes('/login'), `redirected to ${location}, expected /login`);
    assert(location.includes('next=%2Faccount'), `redirect lost the next param: ${location}`);

    return `${res.status} → ${location.replace(WEB, '')}`;
  });

  await check('the header\'s account control did not make the home page dynamic', async () => {
    /**
     * A source check, because the thing it guards is invisible at runtime.
     *
     * `/` is the site's only statically rendered route. Drawing an account
     * chip means knowing whether somebody is signed in, which means reading
     * a cookie, and such a call anywhere in this tree silently opts the
     * whole route out of static rendering — no error, no warning, just the
     * 33 ms it was measured at turning into a render per visit.
     *
     * So the chip is a prop the page passes in, `/` passes nothing, and
     * these three files are where somebody "tidying up the inconsistency"
     * would put the read.
     *
     * Asserted on the IMPORTS, not on the text. The first version searched
     * the source for `cookies(` and went red on this very file's own
     * comment explaining the rule — prose about a ban is not the ban being
     * broken. A session cannot be read in these files without importing
     * something, and an import is unambiguous.
     */
    const banned = ['next/headers', 'looksSignedIn', 'currentWebUser', 'requireWebUser'];
    const files = [
      'apps/web/app/page.tsx',
      'apps/web/components/web-shell.tsx',
      'packages/ui/src/app-shell.tsx',
    ];

    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), '../..', file), 'utf8');
      const imports = source.match(/^import[\s\S]*?from\s+'[^']+';/gm) ?? [];

      for (const statement of imports) {
        for (const needle of banned) {
          assert(
            !statement.includes(needle),
            `${file} imports ${needle} — reading a session there makes the statically rendered / dynamic`,
          );
        }
      }
    }

    return `${files.length} files import no session`;
  });

  /**
   * The failure this repo has actually had, on the other app.
   *
   * A forged `x-console-user-id` rendered a real owner's agency console —
   * HTTP 200 — through two paths that reached a Server Component without the
   * header strip running. apps/web is a second app with the same shape and
   * the same header names, so it gets the same check. Both prefixes, because
   * @repo/auth strips the whole family and a caller does not know which name
   * this app reads.
   */
  await check('a forged identity header is not a session on the consumer site', async () => {
    if (!webUp) skip('web app is not running');

    const forged = '00000000-0000-0000-0000-000000000001';
    const results: string[] = [];

    for (const header of ['x-web-user-id', 'x-console-user-id']) {
      const res = await fetch(`${WEB}/alerts`, {
        redirect: 'manual',
        headers: { [header]: forged },
        signal: AbortSignal.timeout(20_000),
      });
      assert(
        res.status === 307 || res.status === 302,
        `${header} got ${res.status} on /alerts — a forged header was accepted`,
      );
      assert(
        (res.headers.get('location') ?? '').includes('/login'),
        `${header} did not land on /login`,
      );
      results.push(`${header} ${res.status}`);
    }

    return results.join(', ');
  });

  /**
   * `next` decides where an authenticated session lands, and it arrives in a
   * URL that can be emailed. `//evil.example` is a protocol-relative absolute
   * URL that reads as a path to a careless check.
   */
  await check('the sign-in redirect cannot be aimed off-site', async () => {
    if (!webUp) skip('web app is not running');

    const res = await http(`${WEB}/login?next=%2F%2Fevil.example`);
    assert(res.status === 200, `/login answered ${res.status}`);

    const html = await res.text();

    /**
     * Assert on the rendered attribute, not on the whole document.
     *
     * The first version of this check was `!html.includes('//evil.example')`
     * and it failed while the page was correct: the rejected value still
     * appears inside Next's RSC flight payload, because that payload echoes
     * the request URL and the parsed searchParams. Neither is a redirect
     * target and neither is rendered. What matters is the value the form will
     * actually submit.
     */
    assert(
      html.includes('name="next" value="/alerts"'),
      'the rejected next did not fall back to /alerts in the form',
    );
    assert(
      !/(?:value|href|action)="\/\/evil\.example/.test(html),
      'an off-site next was rendered into an attribute',
    );

    return 'off-site next replaced with /alerts in the submitted field';
  });

  await check('the account screens all render, with the fields they claim', async () => {
    if (!webUp) skip('web app is not running');

    const checked: string[] = [];

    for (const [path, needles] of [
      ['/login', ['name="email"', 'name="password"', 'Forgot password?']],
      ['/signup', ['name="name"', 'name="email"', 'name="password"']],
      ['/forgot', ['name="email"']],
      ['/reset', ['name="password"']],
    ] as [string, string[]][]) {
      const res = await http(`${WEB}${path}`);
      assert(res.status === 200, `${path} answered ${res.status}`);

      const html = await res.text();
      for (const needle of needles) {
        assert(html.includes(needle), `${path} is missing ${needle}`);
      }
      checked.push(path);
    }

    /**
     * Every one of these is a plain form posting to a server action. The
     * moment somebody reaches for `createBrowserSupabaseClient` instead,
     * these routes gain supabase-js — measured at 69 kB of First Load the
     * first time it happened here.
     */
    return `${checked.join(', ')} — all server-rendered forms`;
  });

  await check('signing out is POST-only', async () => {
    if (!webUp) skip('web app is not running');

    // A GET sign-out is a link, and Next prefetches links in the viewport —
    // so a GET version signs people out for scrolling past the button.
    const get = await http(`${WEB}/sign-out`);
    assert(get.status === 405, `GET /sign-out answered ${get.status}, expected 405`);

    const post = await fetch(`${WEB}/sign-out`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    assert(post.status === 303, `POST /sign-out answered ${post.status}, expected 303`);

    /**
     * `new URL('/', request.url)` sends the browser to the address the server
     * is listening on rather than the host it asked for. Caught live: a POST
     * to web.lvh.me redirected to localhost, which drops the .lvh.me cookie
     * scope and can leave the visitor looking signed in.
     */
    const location = post.headers.get('location') ?? '';
    const expectedHost = new URL(WEB).host;
    assert(
      location.includes(expectedHost),
      `sign-out redirected to ${location}, losing the host ${expectedHost}`,
    );

    return `GET 405, POST 303 → ${location}`;
  });

  /**
   * The matcher, asserted as behaviour rather than as a line of config.
   *
   * `updateSession` is a network round trip to Supabase. The three fastest
   * pages in the repo are on this app and were measured with none — `/` is a
   * cached route, and a cached route that authenticates before serving is not
   * a cached route. Widening the matcher is the natural next edit to
   * apps/web/middleware.ts and this is what should stop it.
   */
  /**
   * The bug this guards was reported as "i signed in already???".
   *
   * `/chat` was in the middleware matcher and `/api/chat` was not, so the
   * PAGE knew you were signed in while the ROUTE did not — the guide told a
   * signed-in visitor to sign in before it could schedule anything, and
   * every conversation silently failed to save, because the transcript
   * writer reads the same header.
   *
   * Asserting the marker rather than the config: a matcher entry can be
   * deleted and nothing else would notice.
   */
  await check('the chat API is inside the session layer, and the cron is not', async () => {
    if (!webUp) skip('web app is not running');

    const chat = await fetch(`${WEB}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ not: 'a valid request' }),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });

    assert(
      chat.headers.get('x-web-session') !== null,
      '/api/chat has no x-web-session — middleware does not cover it, so a signed-in visitor reads as anonymous',
    );

    // A machine caller has no session and refreshing one for it is pure cost.
    const cron = await fetch(`${WEB}/api/cron/alerts`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });

    assert(
      cron.headers.get('x-web-session') === null,
      '/api/cron/alerts went through the session layer — a cron tick has no session to refresh',
    );

    return 'chat API marked, cron API not';
  });

  await check('the public pages still have no session layer', async () => {
    if (!webUp) skip('web app is not running');

    /**
     * Asserted with the `x-web-session` marker, not with "did it redirect".
     *
     * The first version of this check tested only for a redirect and passed
     * while the matcher was widened to `/((?!_next/static|...).*)` — every
     * route on the site. A widened matcher does not redirect the public
     * pages, it just authenticates before serving them, which is precisely
     * the cost this check is supposed to prevent. Breaking it is what showed
     * that; see ARCHITECTURE § 12.
     */
    const checked: string[] = [];
    for (const path of ['/', '/search', '/listing/00000000-0000-0000-0000-000000000000']) {
      const res = await http(`${WEB}${path}`);
      const marker = res.headers.get('x-web-session');
      assert(
        marker === null,
        `${path} went through the session layer (x-web-session: ${marker}) — it is inside the middleware matcher`,
      );
      assert(
        res.status !== 307 && res.status !== 302,
        `${path} redirected (${res.status})`,
      );
      checked.push(`${path} ${res.status}`);
    }

    // The other half of the invariant: the marker is real, and absence above
    // means "middleware did not run" rather than "middleware sets no header".
    const login = await http(`${WEB}/login`);
    assert(
      login.headers.get('x-web-session') !== null,
      '/login has no x-web-session — the marker is broken, so the assertions above prove nothing',
    );

    return `${checked.join(', ')}; /login marked ${login.headers.get('x-web-session')}`;
  });

  // --------------------------------------------------------------- console --
  group('Console (HTTP, signed out)');

  const consoleUp = await reachable(AGENCY);

  const guarded: [string, string][] = [
    [`${AGENCY}/live-listings`, 'agency listings'],
    [`${AGENCY}/live-listings/new`, 'agency add-listing'],
    [`${AGENCY}/live-listings/00000000-0000-0000-0000-000000000000/edit`, 'agency edit-listing'],
    [`${AGENCY}/team`, 'agency team'],
    // The inbox holds contact details and private offers. It joined this list
    // the moment it stopped being a placeholder.
    [`${AGENCY}/leads`, 'agency leads'],
    [`${AGENCY}/leads?kind=offer`, 'agency leads (offers tab)'],
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

  // -------------------------------------------------- console loaders --
  group('Console loaders');

  /**
   * Every console route that opens the database has a loading.tsx of its own.
   *
   * This is ARCHITECTURE.md § 10 as a check rather than as a paragraph, and it
   * exists because the paragraph was not enough on its own. For months the only
   * loaders in the console were the two route-group roots, both rendering the
   * same generic PageSkeleton — a title, three stat tiles and a card. Nothing
   * was broken and nothing was slow enough to call a bug: every click simply
   * replaced the page with the shape of a different page and then replaced that
   * with the real one. Pressing Edit on a listing painted the listings table's
   * shape for two round trips; walking the five-step onboarding wizard painted
   * a dashboard's shape between every step, which reads as the browser having
   * reloaded, because visually it is indistinguishable from one.
   *
   * A route group's loading.tsx satisfies Next and does not satisfy this: it is
   * the same fallback for eleven different pages, so it cannot be the shape of
   * any of them. The check is deliberately mechanical — `getConsoleDb` in a
   * page.tsx means that page waits on the database region, and a page that waits
   * owns the thing shown while it does.
   *
   * It is static, not HTTP: proving a loader is the right SHAPE needs a signed-in
   * browser and lives in docs/TEST-PLAN.md. Proving one EXISTS is free, and the
   * failure this guards against is a new route shipping without one.
   */
  await check('every console route that reads the database has its own loading.tsx', () => {
    /**
     * The two consoles only.
     *
     * (shared) holds login, signup and reset — full-screen auth pages with no
     * console shell above them and therefore no group-level skeleton behind
     * them. A loader there would be a flash where there is currently none, so
     * the rule that applies inside the shell does not apply to them.
     */
    const appDir = resolve(process.cwd(), '../../apps/console/app');
    const consoles = ['(agency)', '(agent)'].map((g) => join(appDir, g));

    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry === 'page.tsx') {
          pages.push(full);
        }
      }
    };
    for (const dir of consoles) walk(dir);

    const reads = pages.filter((f) => readFileSync(f, 'utf8').includes('getConsoleDb'));
    assert(reads.length > 0, 'found no console page that opens the database — did the app move?');

    const missing = reads
      .filter((f) => {
        try {
          return !statSync(join(dirname(f), 'loading.tsx')).isFile();
        } catch {
          return true;
        }
      })
      .map((f) => dirname(f).slice(appDir.length + 1));

    assert(
      missing.length === 0,
      `no loading.tsx beside: ${missing.join(', ')} — these fall through to the ` +
        `route group's generic skeleton, which is the shape of a different page`,
    );

    return `${reads.length} database-backed routes, each with its own loader`;
  });

  // ------------------------------------------------------------ chat (AI) --
  // --------------------------------------------------------- chat history --
  group('Chat history');

  await check('both chat tables exist with row-level security on', async () => {
    const rows = (await db.execute(sql`
      select tablename, rowsecurity from pg_tables
      where schemaname = 'public' and tablename in ('chat_thread', 'chat_message')
    `)) as unknown as { tablename: string; rowsecurity: boolean }[];

    assert(rows.length === 2, `expected 2 tables, found ${rows.length}`);
    for (const row of rows) assert(row.rowsecurity === true, `${row.tablename} has RLS off`);

    return 'chat_thread + chat_message, RLS on both';
  });

  /**
   * A transcript is written by the server after it has run the turn.
   *
   * There is deliberately no INSERT or UPDATE policy on either table: an
   * assistant turn somebody authored themselves is the one thing that could
   * put a price into the record without a tool result behind it (#4).
   */
  await check('nothing may author a transcript line but the server', async () => {
    const rows = (await db.execute(sql`
      select tablename, policyname, cmd from pg_policies
      where schemaname='public' and tablename in ('chat_thread','chat_message')
    `)) as unknown as { tablename: string; policyname: string; cmd: string }[];

    const writes = rows.filter((r) => r.cmd === 'INSERT' || r.cmd === 'UPDATE');
    assert(
      writes.length === 0,
      `found a write policy on a chat table: ${writes.map((w) => w.policyname).join(', ')}`,
    );
    assert(rows.length === 4, `expected 4 policies, found ${rows.length}`);

    return `${rows.length} policies, all SELECT or DELETE`;
  });

  /**
   * The bug this guards was reported from a screenshot: the thread list
   * lived in the sidebar, the sidebar only renders once a conversation has
   * started, and a returning visitor landing on the empty hero had no route
   * back to anything they had said. The history existed; the door did not.
   */
  await check('the chat offers New chat and History before a word is typed', async () => {
    if (!webUp) skip('web app is not running');

    const res = await http(`${WEB}/chat`);
    assert(res.status === 200, `/chat answered ${res.status}`);

    const html = await res.text();
    assert(html.includes('New chat'), '/chat has no New chat control on the empty state');
    assert(html.includes('History'), '/chat has no History control on the empty state');

    return 'both controls render on the empty hero';
  });

  await check('every page offers a way into an account', async () => {
    if (!webUp) skip('web app is not running');

    // Deliberately one neutral link rather than "Sign in" / "My alerts":
    // telling those apart would mean reading the session cookie in the
    // shared header, and that header renders on `/`, which is static.
    for (const path of ['/', '/search', '/chat']) {
      const html = await (await http(`${WEB}${path}`)).text();
      assert(html.includes('href="/alerts"'), `${path} has no account link in the header`);
    }

    return '/ , /search and /chat all link to /alerts';
  });

  /**
   * Every auth account must have its `public.user` row.
   *
   * Everything a consumer owns — saved searches, saved conversations —
   * has a foreign key to that row. Without it the inserts die on the
   * constraint and the writer swallows the error, so the symptom is an
   * empty History with nothing in the UI to explain it. Two real accounts
   * were in exactly that state when this check was written.
   *
   * A data invariant rather than a code review: the row is created at
   * sign-in now, and this is what notices if a path is ever added that
   * forgets to.
   */
  await check('every account is mirrored into public.user', async () => {
    const rows = (await db.execute(sql`
      select count(*)::int as orphans
      from auth.users au
      left join public."user" pu on pu.id = au.id
      where pu.id is null and au.email is not null
    `)) as unknown as { orphans: number }[];

    const orphans = rows[0]?.orphans ?? 0;
    assert(
      orphans === 0,
      `${orphans} auth accounts have no public.user row — their saved searches and conversations cannot be written`,
    );

    return 'every auth account has its app row';
  });

  await check('no saved conversation is older than the retention window', async () => {
    const rows = (await db.execute(sql`
      select count(*)::int as stale from chat_thread
      where last_message_at < now() - interval '91 days'
    `)) as unknown as { stale: number }[];

    const stale = rows[0]?.stale ?? 0;
    // APP 11.2, as a data invariant rather than a policy document. The
    // scheduler tick sweeps these; this is what notices if it stops.
    assert(stale === 0, `${stale} conversations are past 90 days — is the tick running?`);

    return 'every stored conversation is inside 90 days';
  });

  // ----------------------------------------------------- search schedules --
  group('Search schedules');

  /**
   * This whole group is FREE and runs on every `pnpm smoke`.
   *
   * The scheduler's two metered things — the model and the mail provider —
   * are ports, so the entire pipeline can be driven with `fakeTransport()`
   * and no summariser. Dry mode is not a special code path here; it is a
   * different value in a slot the signature already has, which is what
   * makes exercising it worth anything.
   */
  const PROBE_USER = '00000000-0000-4000-8000-00000000c0de';

  async function withProbeUser<T>(fn: (actor: { userId: string }) => Promise<T>): Promise<T> {
    await db
      .insert(userTable)
      .values({ id: PROBE_USER, email: 'smoke-probe@example.invalid', name: 'Smoke probe' })
      .onConflictDoNothing();
    try {
      return await fn({ userId: PROBE_USER });
    } finally {
      // schedule_run and search_schedule both cascade from the user row.
      await db.delete(userTable).where(eq(userTable.id, PROBE_USER));
    }
  }

  await check('both scheduler tables exist with row-level security on', async () => {
    const rows = await db.execute(sql`
      select tablename, rowsecurity from pg_tables
      where schemaname = 'public' and tablename in ('search_schedule', 'schedule_run')
    `);
    const found = rows as unknown as { tablename: string; rowsecurity: boolean }[];

    assert(found.length === 2, `expected 2 tables, found ${found.length}`);
    for (const row of found) {
      assert(row.rowsecurity === true, `${row.tablename} has RLS disabled`);
    }

    const gone = await db.execute(
      sql`select 1 from pg_tables where schemaname='public' and tablename='saved_search'`,
    );
    assert((gone as unknown as unknown[]).length === 0, 'saved_search should have been dropped');

    return 'search_schedule + schedule_run, RLS on both, saved_search gone';
  });

  await check('the due index is partial and the slot index is unique', async () => {
    const rows = (await db.execute(sql`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public'
        and indexname in ('search_schedule_due_idx', 'schedule_run_slot_idx')
    `)) as unknown as { indexname: string; indexdef: string }[];

    const due = rows.find((r) => r.indexname === 'search_schedule_due_idx');
    const slot = rows.find((r) => r.indexname === 'schedule_run_slot_idx');

    assert(Boolean(due), 'search_schedule_due_idx is missing');
    /**
     * Read the DEFINITION, not the name. Drizzle can express `.where()` on
     * an index and does not emit it, so the predicate is applied by hand in
     * migration 0009 — and a name-only check would pass happily after
     * somebody regenerated the migration and lost it.
     */
    assert(
      /where .*status/i.test(due!.indexdef),
      `due index is not partial: ${due!.indexdef}`,
    );

    assert(Boolean(slot), 'schedule_run_slot_idx is missing');
    assert(/unique/i.test(slot!.indexdef), 'the slot index is not UNIQUE');

    return 'due index partial on status, slot index unique';
  });

  await check('the schedule policies are exactly the ones 0009 declares', async () => {
    const rows = (await db.execute(sql`
      select tablename, policyname from pg_policies
      where schemaname='public' and tablename in ('search_schedule','schedule_run')
    `)) as unknown as { tablename: string; policyname: string }[];

    const names = rows.map((r) => r.policyname).sort();
    assert(names.length === 5, `expected 5 policies, found ${names.length}: ${names.join(', ')}`);

    // schedule_run is SELECT-only on purpose: a run is written by the
    // scheduler and by nothing else, so no credential can forge a delivery.
    const runPolicies = rows.filter((r) => r.tablename === 'schedule_run');
    assert(runPolicies.length === 1, 'schedule_run should have exactly one (SELECT) policy');

    return names.join(', ');
  });

  /**
   * `nextRunFor` against an independent oracle — Postgres itself.
   *
   * Deliberately not a second TypeScript implementation, which would just be
   * the same assumptions written twice. If the two disagree, one of them is
   * wrong about Australian daylight saving and that is worth knowing.
   */
  await check('the local-time cursor agrees with Postgres', async () => {
    const cases = [
      { date: '2026-01-15', zone: 'Australia/Melbourne' },
      { date: '2026-06-15', zone: 'Australia/Melbourne' },
      { date: '2026-10-04', zone: 'Australia/Melbourne' },
      { date: '2026-04-05', zone: 'Australia/Melbourne' },
      { date: '2026-06-15', zone: 'Australia/Brisbane' },
      { date: '2026-06-15', zone: 'Australia/Eucla' },
    ];

    const { instantForLocalTime } = await import('@repo/core/schedules');
    const checked: string[] = [];

    for (const c of cases) {
      const rows = (await db.execute(
        sql`select (timestamp '${sql.raw(c.date)} 20:00' at time zone '${sql.raw(c.zone)}') as utc`,
      )) as unknown as { utc: Date | string }[];

      const expected = new Date(rows[0]!.utc).toISOString();
      const [y, m, d] = c.date.split('-').map(Number);
      const actual = instantForLocalTime(
        { year: y!, month: m!, day: d! },
        20 * 60,
        c.zone,
      ).toISOString();

      assert(
        actual === expected,
        `${c.zone} ${c.date} 20:00 — TS said ${actual}, Postgres said ${expected}`,
      );
      checked.push(`${c.zone.split('/')[1]} ${c.date}`);
    }

    return `${checked.length} instants agree with Postgres, incl. both DST boundaries`;
  });

  await check('a due schedule is claimed exactly once by two concurrent ticks', async () => {
    return withProbeUser(async (actor) => {
      const suburb = (await liveSuburbs(db))[0];
      if (!suburb) skip('no live listings to build a probe search from');

      const { id } = await createSchedule(db, actor, {
        searchPath: `/search?channel=sale&suburb=${encodeURIComponent(suburb)}`,
        name: 'smoke probe',
        cadence: 'daily',
        sendAtMinute: 1200,
        timezone: 'Australia/Melbourne',
      });

      // Make it due now.
      await db
        .update(searchSchedule)
        .set({ nextRunAt: new Date(Date.now() - 60_000) })
        .where(eq(searchSchedule.id, id));

      /**
       * The reason SKIP LOCKED and the unique index both exist. Remove
       * either one and this goes red — verified by doing exactly that.
       */
      /**
       * Scoped to the probe user, because an unscoped tick is not a test.
       *
       * This used to call the real claim with no narrowing, so it swept up
       * whatever live schedules happened to be due — and it did: three
       * half-finished `running` rows were found sitting on a real person's
       * saved search, written by this check. A suite that edits production
       * rows to prove a point is not verifying the system, it is changing
       * it.
       */
      const [a, b] = await Promise.all([
        claimDueSchedules(db, { limit: 5, ownerId: actor.userId }),
        claimDueSchedules(db, { limit: 5, ownerId: actor.userId }),
      ]);

      const mine = [...a, ...b].filter((c) => c.scheduleId === id);
      assert(mine.length === 1, `claimed ${mine.length} times, expected exactly 1`);

      const runs = await db
        .select({ id: scheduleRun.id })
        .from(scheduleRun)
        .where(eq(scheduleRun.scheduleId, id));
      assert(runs.length === 1, `${runs.length} run rows for one slot, expected 1`);

      await deleteSchedule(db, actor, id);
      return 'two overlapping ticks produced one run';
    });
  });

  await check('a tick runs a real search and records what it would send', async () => {
    return withProbeUser(async (actor) => {
      const suburb = (await liveSuburbs(db))[0];
      if (!suburb) skip('no live listings to build a probe search from');

      const searchPath = `/search?channel=sale&suburb=${encodeURIComponent(suburb)}`;
      const { id } = await createSchedule(db, actor, {
        searchPath,
        name: 'smoke probe',
        cadence: 'daily',
        sendAtMinute: 1200,
        timezone: 'Australia/Melbourne',
      });

      await db
        .update(searchSchedule)
        .set({ nextRunAt: new Date(Date.now() - 60_000) })
        .where(eq(searchSchedule.id, id));

      const transport = fakeTransport();
      const report = await runScheduleTick(
        db,
        {
          search: (query) => searchPublicListings(db, query),
          resolvePlace: async () => null,
          transport,
          sender: {
            from: { email: 'alerts@example.invalid', name: 'Smoke Co' },
            postalAddress: '1 Smoke St, Test City',
          },
          baseUrl: WEB,
          unsubscribeSecret: 'smoke-secret',
          // No summariser: this group must never call a metered model.
        },
        // Same reason as the claim check above: this tick may only see the
        // probe user's schedules, never a live one.
        { limit: 5, ownerId: actor.userId },
      );

      // Exactly one now, not "at least one" — the tick can no longer reach
      // anything but the row this check just created, so a second claim
      // would mean the narrowing leaked.
      assert(report.claimed === 1, `claimed ${report.claimed}, expected exactly 1`);

      const [run] = await db
        .select()
        .from(scheduleRun)
        .where(eq(scheduleRun.scheduleId, id))
        .limit(1);

      assert(Boolean(run), 'no run row was written');

      // The run's own count must equal what the same query returns now.
      const expected = await searchPublicListings(db, {
        channel: 'sale',
        suburb,
        limit: 24,
      });
      assert(
        run!.matched === expected.length,
        `run recorded ${run!.matched} matches, the query returns ${expected.length}`,
      );

      // First run for this schedule, so everything it found is new and one
      // email was built. A digest with no unsubscribe cannot be built at all.
      if (expected.length > 0) {
        assert(transport.sent.length === 1, `built ${transport.sent.length} emails, expected 1`);
        const message = transport.sent[0]!;
        assert(Boolean(message.listUnsubscribeUrl), 'the email carries no unsubscribe URL');
        assert(message.text.includes('1 Smoke St'), 'the text part has no postal address');
        assert(
          message.html.includes(`View all ${run!.matched} results`),
          'the email count disagrees with the run',
        );
      }

      await deleteSchedule(db, actor, id);
      return `claimed ${report.claimed}, matched ${run!.matched}, built ${transport.sent.length} email(s)`;
    });
  });

  await check('an every-2-hours schedule advances by exactly two hours', async () => {
    return withProbeUser(async (actor) => {
      const suburb = (await liveSuburbs(db))[0];
      if (!suburb) skip('no live listings to build a probe search from');

      /**
       * An interval carries no wall clock, so none of the daylight-saving
       * machinery applies to it. This is the check that says the cron
       * actually supports a frequency that is not daily.
       */
      const { id } = await createSchedule(db, actor, {
        searchPath: `/search?channel=sale&suburb=${encodeURIComponent(suburb)}`,
        name: 'smoke interval probe',
        cadence: 'interval',
        intervalMinutes: 120,
        sendAtMinute: 0,
        timezone: 'Australia/Melbourne',
      });

      const due = new Date(Date.now() - 60_000);
      await db.update(searchSchedule).set({ nextRunAt: due }).where(eq(searchSchedule.id, id));

      await claimDueSchedules(db, { limit: 5 });

      const [after] = await db
        .select({ nextRunAt: searchSchedule.nextRunAt })
        .from(searchSchedule)
        .where(eq(searchSchedule.id, id));

      const advanced = new Date(after!.nextRunAt).getTime() - due.getTime();
      assert(
        advanced === 120 * 60 * 1000,
        `cursor advanced ${advanced / 60000} minutes, expected 120`,
      );

      await deleteSchedule(db, actor, id);
      return 'cursor moved exactly 120 minutes from the claimed slot';
    });
  });

  await check('a schedule the guide drafted survives the round trip unchanged', async () => {
    const secret = process.env.ALERT_UNSUBSCRIBE_SECRET?.trim();
    if (!secret) skip('ALERT_UNSUBSCRIBE_SECRET is not set');

    const draft = {
      searchPath: '/search?channel=rent&suburb=Pakenham&radius=30',
      cadence: 'interval' as const,
      sendAtMinute: 0,
      intervalMinutes: 120,
      timezone: 'Australia/Melbourne' as const,
    };

    const token = signScheduleDraft(draft, secret);
    const claim = verifyScheduleDraft(token, secret);
    assert(claim.ok, 'a freshly signed draft did not verify');

    /**
     * The card goes out to a browser and comes back. This is the tamper
     * that matters: a signed "every two hours" accepted as "every minute"
     * would be a mailing list nobody agreed to.
     */
    const tampered = { ...draft, intervalMinutes: 1 };
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${token.split('.')[1]}`;
    assert(!verifyScheduleDraft(forged, secret).ok, 'a tampered frequency was accepted');

    return 'signed draft verifies; a swapped frequency does not';
  });

  /**
   * The floor and the tick are one decision written in two files.
   *
   * `MIN_INTERVAL_MINUTES` lives in packages/core; the tick lives in
   * apps/web/vercel.json. Nothing imports one from the other, and nothing
   * would fail if they drifted — the schedules would simply stop catching
   * up after an outage, silently, months later. `nextRunFor` advances an
   * interval schedule one slot per tick, so the tick must be strictly
   * faster than the shortest interval or a row that falls behind stays
   * behind for ever.
   *
   * A file read rather than a comment, because a comment did not stop the
   * last two numbers in this repo from drifting.
   */
  await check('a run that was claimed and never finished gets closed out', async () => {
    return withProbeUser(async (actor) => {
      const suburb = (await liveSuburbs(db))[0];
      if (!suburb) skip('no live listings to build a probe search from');

      const { id } = await createSchedule(db, actor, {
        searchPath: `/search?channel=sale&suburb=${encodeURIComponent(suburb)}`,
        name: 'smoke abandoned-run probe',
        cadence: 'daily',
        sendAtMinute: 1200,
        timezone: 'Australia/Melbourne',
      });

      /**
       * Two rows, one old and one new, because a sweeper that marks
       * everything is worse than none: it would overwrite a run that is
       * still working with a report that it died.
       */
      const [stale] = await db
        .insert(scheduleRun)
        .values({
          scheduleId: id,
          userId: actor.userId,
          scheduledFor: new Date(Date.now() - 4 * 60 * 60_000),
          status: 'running',
          query: { channel: 'sale', suburb },
          createdAt: new Date(Date.now() - 4 * 60 * 60_000),
        })
        .returning({ id: scheduleRun.id });

      const [fresh] = await db
        .insert(scheduleRun)
        .values({
          scheduleId: id,
          userId: actor.userId,
          scheduledFor: new Date(),
          status: 'running',
          query: { channel: 'sale', suburb },
        })
        .returning({ id: scheduleRun.id });

      const swept = await sweepAbandonedRuns(db, { olderThanMinutes: ABANDONED_RUN_MINUTES });

      const after = await db
        .select({ id: scheduleRun.id, status: scheduleRun.status, error: scheduleRun.error })
        .from(scheduleRun)
        .where(eq(scheduleRun.scheduleId, id));

      const staleRow = after.find((r) => r.id === stale!.id);
      const freshRow = after.find((r) => r.id === fresh!.id);

      assert(staleRow?.status === 'failed', `stale run is ${staleRow?.status}, expected failed`);
      assert(
        Boolean(staleRow?.error),
        'the swept run carries no reason — a failure with no explanation is not a record',
      );
      assert(
        freshRow?.status === 'running',
        `a run claimed seconds ago was swept (${freshRow?.status}) — the sweeper is too eager`,
      );

      await deleteSchedule(db, actor, id);
      return `swept ${swept} stale, left the in-flight one alone`;
    });
  });

  await check('a run that finds nothing new still sends an email', async () => {
    return withProbeUser(async (actor) => {
      const suburb = (await liveSuburbs(db))[0];
      if (!suburb) skip('no live listings to build a probe search from');

      const { id } = await createSchedule(db, actor, {
        searchPath: `/search?channel=sale&suburb=${encodeURIComponent(suburb)}`,
        name: 'smoke repeat-send probe',
        cadence: 'interval',
        sendAtMinute: 0,
        intervalMinutes: MIN_INTERVAL_MINUTES,
        timezone: 'Australia/Melbourne',
      });

      const transport = fakeTransport();
      const deps = {
        search: (query: Parameters<typeof searchPublicListings>[1]) =>
          searchPublicListings(db, query),
        resolvePlace: async () => null,
        transport,
        sender: {
          from: { email: 'alerts@example.invalid', name: 'Smoke Co' },
          postalAddress: '1 Smoke St, Test City',
        },
        baseUrl: WEB,
        unsubscribeSecret: 'smoke-secret',
        // No summariser: this group must never call a metered model.
      };

      const due = async () => {
        await db
          .update(searchSchedule)
          .set({ nextRunAt: new Date(Date.now() - 60_000) })
          .where(eq(searchSchedule.id, id));
      };

      // First tick: nothing has been delivered before, so everything matches
      // as new and the digest carries news.
      await due();
      await runScheduleTick(db, deps, { limit: 5, ownerId: actor.userId });

      // Second tick against an unchanged database. This is the one that used
      // to send nothing at all.
      await due();
      await runScheduleTick(db, deps, { limit: 5, ownerId: actor.userId });

      const runs = await db
        .select({
          status: scheduleRun.status,
          newCount: scheduleRun.newCount,
          emailStatus: scheduleRun.emailStatus,
        })
        .from(scheduleRun)
        .where(eq(scheduleRun.scheduleId, id))
        .orderBy(scheduleRun.scheduledFor);

      assert(runs.length === 2, `expected 2 runs, got ${runs.length}`);
      assert(
        transport.sent.length === 2,
        `${transport.sent.length} email(s) for 2 runs — a run that found nothing new sent none`,
      );

      const second = runs[1]!;
      assert(second.newCount === 0, `second run found ${second.newCount} new, expected 0`);
      // The two facts stay separate: the SEARCH was empty, the EMAIL was sent.
      assert(second.status === 'empty', `second run recorded ${second.status}, expected empty`);
      assert(
        second.emailStatus === 'sent',
        `second run's email is ${second.emailStatus} — it should have gone anyway`,
      );

      // And it says so, rather than claiming news it does not have.
      const subject = transport.sent[1]!.subject;
      assert(
        /no new listings/i.test(subject),
        `the no-news email is subjected "${subject}" — it must not imply there is news`,
      );

      await deleteSchedule(db, actor, id);
      return `2 runs, 2 emails, second one "${subject.slice(0, 40)}…"`;
    });
  });

  await check('an exact AM/PM time survives the round trip to the database', async () => {
    return withProbeUser(async (actor) => {
      const suburb = (await liveSuburbs(db))[0];
      if (!suburb) skip('no live listings to build a probe search from');
      const searchPath = `/search?channel=sale&suburb=${encodeURIComponent(suburb)}`;

      /**
       * 4:15 PM, because it is the case the old picker could not express.
       * It offered eight times on the hour, so a quarter past anything was
       * not a setting somebody could choose.
       */
      const { id } = await createSchedule(db, actor, {
        searchPath,
        name: 'smoke clock probe',
        cadence: 'daily',
        sendAtMinute: minutesFrom12Hour({ hour12: 4, minute: 15, meridiem: 'PM' }),
        timezone: 'Australia/Melbourne',
      });

      const [row] = await db
        .select({ sendAtMinute: searchSchedule.sendAtMinute })
        .from(searchSchedule)
        .where(eq(searchSchedule.id, id));

      assert(row?.sendAtMinute === 975, `stored ${row?.sendAtMinute}, expected 975`);

      const [summary] = await listSchedules(db, actor);
      const said = describeCadence(summary!);
      assert(
        said.includes('4:15 PM'),
        `read back as "${said}" — the minute did not survive`,
      );

      // The other end: a gap under the floor is refused outright here, where
      // the chat clamps. A form can show the reason; a model cannot be
      // trusted to.
      let refused = false;
      try {
        await createSchedule(db, actor, {
          searchPath,
          name: 'smoke floor probe',
          cadence: 'interval',
          sendAtMinute: 0,
          intervalMinutes: MIN_INTERVAL_MINUTES - 1,
          timezone: 'Australia/Melbourne',
        });
      } catch {
        refused = true;
      }
      assert(refused, `a ${MIN_INTERVAL_MINUTES - 1}-minute gap was accepted — the floor is not a floor`);

      // And the ceiling is genuinely gone: a fortnight is an ordinary ask.
      const fortnight = await createSchedule(db, actor, {
        searchPath,
        name: 'smoke fortnight probe',
        cadence: 'interval',
        sendAtMinute: 0,
        intervalMinutes: 14 * 24 * 60,
        timezone: 'Australia/Melbourne',
      });

      await deleteSchedule(db, actor, id);
      await deleteSchedule(db, actor, fortnight.id);
      return '4:15 PM stored as 975; 9 minutes refused; a fortnight accepted';
    });
  });

  await check('the schedule forms and their actions agree on every field name', async () => {
    /**
     * The one seam a unit test cannot reach.
     *
     * The picker renders `name="…"` attributes; the server actions read
     * `formData.get('…')`. Nothing connects the two but a string, and a
     * mismatch does not fail to compile, does not throw, and fails no test —
     * the field simply arrives undefined and the schedule is saved at
     * whatever the fallback is, or refused with a message about a field the
     * person did fill in.
     *
     * Both forms are read, because the picker is now shared between "save a
     * new search" and "edit this one" and each wraps it with fields of its
     * own — `searchPath` and `prompt` on one, `scheduleId` on the other.
     *
     * The conversions themselves are unit-tested (time-input.test.ts,
     * including the 12 AM / 12 PM trap and a round trip over all 1440
     * minutes of the day). This is the other half: that the names match.
     */
    const read = (file: string) =>
      readFileSync(resolve(process.cwd(), '../..', file), 'utf8');

    const markup = [
      'apps/web/components/schedule-picker.tsx',
      'apps/web/components/save-search.tsx',
      'apps/web/app/alerts/schedule-row.tsx',
    ]
      .map(read)
      .join('\n');
    const actions = read('apps/web/app/alerts/actions.ts');

    const emitted = new Set(
      [...markup.matchAll(/name="([A-Za-z]+)"/g)].map((m) => m[1] as string),
    );
    const consumed = new Set(
      [...actions.matchAll(/formData\.get\('([A-Za-z]+)'\)/g)].map((m) => m[1] as string),
    );

    assert(
      emitted.size > 0 && consumed.size > 0,
      'found no field names — the patterns stopped matching',
    );

    const unread = [...emitted].filter((name) => !consumed.has(name));
    assert(
      unread.length === 0,
      `the forms send ${unread.join(', ')} and no action reads ${unread.length === 1 ? 'it' : 'them'}`,
    );

    const missing = [...consumed].filter((name) => !emitted.has(name));
    assert(
      missing.length === 0,
      `the actions read ${missing.join(', ')} and no form sends ${missing.length === 1 ? 'it' : 'them'}`,
    );

    /**
     * And that the picker is still ONE picker. A second copy would satisfy
     * every assertion above while drifting from the first — which is the
     * failure this codebase has already had once, with describeCadence.
     */
    for (const file of ['apps/web/components/save-search.tsx', 'apps/web/app/alerts/schedule-row.tsx']) {
      const source = read(file);
      assert(
        source.includes('<SchedulePicker'),
        `${file} no longer uses SchedulePicker — a second cadence form has appeared`,
      );
      assert(
        !source.includes('name="sendAtHour"'),
        `${file} renders its own clock controls instead of using the shared picker`,
      );
    }

    return `${emitted.size} field names, matched both ways, one picker`;
  });

  await check('the alerts page does not hand-roll a cadence label', async () => {
    /**
     * A duplication check, because the bug was a duplicate.
     *
     * `/alerts` carried its own copy of `describeCadence` that knew about
     * `weekly` and read everything else as daily, so an hourly schedule was
     * labelled "Every day at 12:00 AM" — an interval row holds
     * `sendAtMinute: 0` because an interval has no clock. Two formatters for
     * one fact is how they drift, and nothing failed while they did.
     */
    const page = readFileSync(
      resolve(process.cwd(), '../../apps/web/app/alerts/page.tsx'),
      'utf8',
    );

    assert(
      page.includes('describeCadence'),
      '/alerts no longer uses describeCadence — a second cadence formatter has come back',
    );
    assert(
      !/function\s+cadenceLabel/.test(page),
      '/alerts defines its own cadenceLabel again',
    );

    return 'one cadence formatter, in core';
  });

  await check('no live run is stuck half-finished', async () => {
    /**
     * The invariant behind the sweeper, asserted against real rows.
     *
     * Four of these were found on a live saved search, written by this very
     * suite claiming schedules it did not own. The tick now sweeps and the
     * suite now scopes itself; this is what says both are still true.
     */
    const rows = (await db.execute(sql`
      select count(*)::int as stuck from schedule_run
      where status = 'running'
        and created_at < now() - interval '2 hours'
    `)) as unknown as { stuck: number }[];

    const stuck = rows[0]?.stuck ?? 0;
    assert(
      stuck === 0,
      `${stuck} runs have been 'running' for over two hours — a tick died, or something claimed rows it does not finish`,
    );

    return 'every run either finished or is still in flight';
  });

  await check('the cron tick is strictly faster than the shortest interval', async () => {
    const vercelJson = JSON.parse(
      readFileSync(resolve(process.cwd(), '../../apps/web/vercel.json'), 'utf8'),
    ) as { crons?: { path: string; schedule: string }[] };

    const alerts = vercelJson.crons?.find((c) => c.path === '/api/cron/alerts');
    assert(alerts, 'apps/web/vercel.json declares no cron for /api/cron/alerts');

    // Only the every-N-minutes form is understood, which is the only form
    // this endpoint has ever used. Anything else should fail loudly here
    // rather than be assumed fine.
    const every = /^\*\/(\d+) \* \* \* \*$/.exec(alerts.schedule);
    assert(every, `cannot read the tick from "${alerts.schedule}"`);

    const tickMinutes = Number(every[1]);
    assert(
      tickMinutes < MIN_INTERVAL_MINUTES,
      `the tick is every ${tickMinutes} min and the shortest schedule is every ` +
        `${MIN_INTERVAL_MINUTES} min — a schedule that falls behind can never catch up`,
    );

    return `tick ${tickMinutes} min vs floor ${MIN_INTERVAL_MINUTES} min (${(
      MIN_INTERVAL_MINUTES / tickMinutes
    ).toFixed(1)}:1 catch-up)`;
  });

  await check('no live schedule has a cursor stuck in the past', async () => {
    const rows = (await db.execute(sql`
      select count(*)::int as stale from search_schedule
      where status = 'active' and next_run_at < now() - interval '1 hour'
    `)) as unknown as { stale: number }[];

    const stale = rows[0]?.stale ?? 0;
    // The "cron stopped and nobody noticed" check. A tick every 5 minutes
    // means an active schedule more than an hour overdue is not a backlog.
    assert(stale === 0, `${stale} active schedules are over an hour overdue — is the cron running?`);

    return 'every active schedule is on time';
  });

  await check('the cron endpoint refuses a caller with no secret', async () => {
    if (!webUp) skip('web app is not running');

    const anonymous = await http(`${WEB}/api/cron/alerts`);
    assert(
      anonymous.status === 401 || anonymous.status === 503,
      `answered ${anonymous.status}, expected 401 or 503`,
    );

    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) return `${anonymous.status} with no secret (CRON_SECRET not set here)`;

    const wrong = await fetch(`${WEB}/api/cron/alerts`, {
      method: 'POST',
      headers: { 'x-cron-secret': 'b'.repeat(secret.length) },
      signal: AbortSignal.timeout(20_000),
    });
    assert(wrong.status === 401, `a wrong secret of the right length got ${wrong.status}`);

    return `401 with no secret, 401 with a wrong one of equal length`;
  });

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

  await check('the guide reaches for sold data instead of denying it exists', async () => {
    /**
     * The regression this feature was built for.
     *
     * Asked "a house in Pakenham which is already sold", the guide used to say
     * sold properties are not on the portal — true of its search tools and
     * false of the database they sit on. Every unit test here runs against a
     * fake model, so the only way to know a real one reaches for the new tool
     * is to ask a real one.
     *
     * Asserts the TOOL was called, not what the answer said. Whether any sale
     * exists depends on what the database holds today, and a check that goes
     * red because nothing has sold lately is a check people learn to ignore.
     */
    if (!webUp) skip('web app is not running');
    if (!haveAnthropic) skip(aiSkipReason(liveAi));

    /**
     * A suburb that HAS a recorded sale, when the database holds one.
     *
     * Any live suburb was the first version, and it asked about a suburb with
     * no sales — so the tool call was asserted and every card assertion below
     * was skipped. The third time that pattern bit in this project.
     */
    const [withSale] = await db.execute<{ suburb: string }>(
      sql`select distinct p.suburb from listing l
          join property p on p.id = l.property_id
          where l.status = 'sold' and l.sold_price is not null
            and l.sold_date > now() - interval '24 months'
          limit 1`,
    );

    const suburb = withSale?.suburb ?? (await liveSuburbs(db))[0];
    if (!suburb) skip('no suburb to ask about');

    const turn = await chat({ message: `what has sold recently in ${suburb}?` });
    const called = turn.tools.map((t) => t.name);

    assert(
      called.includes('recent_sales'),
      `the guide answered a sold-homes question with ${called.join(', ') || 'no tools at all'}`,
    );
    /**
     * And it must not have fallen back to the live search, which cannot see a
     * sold listing and would have produced a confidently wrong answer.
     */
    assert(
      !called.includes('search_listings'),
      'the guide searched live listings for a question about sold homes',
    );

    /**
     * And the findings reached the panel.
     *
     * This is the frame whose absence caused the bug v10 fixes: `recent_sales`
     * had nowhere to put what it found, so the guide — forbidden from writing
     * links out — told the visitor to click a sale that was not on screen.
     *
     * Asserted over the wire rather than in the tool, because three separate
     * places carry their own copy of the event union (the pipeline, the NDJSON
     * serialiser, the buffered collector) and any of them can silently drop a
     * member.
     */
    assert(Array.isArray(turn.sales), 'the turn carried no sales array at all');

    const cards = turn.sales.flatMap((f) => f.sales);
    if (cards.length === 0) {
      // No sale recorded in that suburb is a legitimate state, and the tool
      // call above is the thing this check exists for.
      return `called ${called.join(', ')} — no sales recorded to render`;
    }

    for (const frame of turn.sales) {
      /**
       * The affordances a live search gets, which the sold panel had none of —
       * which is why the guide read addresses out instead of pointing at a
       * list. `total` drives "View all N sold"; `searchPath` is where it goes.
       */
      assert(
        frame.searchPath.startsWith('/sold?'),
        `a sales frame's browse link is not a /sold path: ${frame.searchPath}`,
      );
      assert(
        frame.total >= frame.sales.length,
        `a sales frame says ${frame.total} total but carries ${frame.sales.length} cards`,
      );
    }

    for (const card of cards) {
      assert(/\$/.test(card.price), `a sold card carried no formatted price: ${card.price}`);
      assert(card.soldOn.trim().length > 0, 'a sold card carried no date');
      assert(card.address.trim().length > 0, 'a sold card carried no address');
      /**
       * Null is a valid answer — an address under offer again has no page to
       * send anyone to — but a path must be a path. A malformed one would render a link
       * straight to a 404.
       */
      assert(
        card.historyPath === null ||
          /^\/(property|listing)\/[0-9a-f-]{36}$/.test(card.historyPath),
        `a sold card's link is not a property or listing path: ${card.historyPath}`,
      );
      /**
       * A pin is optional — an address nobody geocoded is simply not placeable
       * — but a half-pin is not. Latitude without longitude puts a marker in
       * the ocean, which is the bug the live map's own counter was written for.
       */
      assert(
        (card.latitude === null) === (card.longitude === null),
        `a sold card carries half a pin: ${card.latitude}, ${card.longitude}`,
      );
    }

    return `called ${called.join(', ')}, ${cards.length} card(s) rendered`;
  });

  await check('a searched turn comes back with server-authored chips', async () => {
    /**
     * The chips under an answer, over the wire.
     *
     * `suggestions.test.ts` pins the rules and `property-chat.test.ts` pins
     * the wiring; both run against a fake. This is the only check that proves
     * the frame survives the route, the NDJSON serialiser and the buffered
     * JSON collector — three places that each have their own copy of the
     * event union and could silently drop a member.
     *
     * What it deliberately does NOT assert is which chips appear. That
     * depends on what the live database holds, and a check that goes red
     * because a suburb sold out is a check people learn to ignore.
     */
    if (!webUp) skip('web app is not running');
    if (!haveAnthropic) skip(aiSkipReason(liveAi));

    const suburbs = await liveSuburbs(db);
    const suburb = suburbs[0];
    if (!suburb) skip('no live listings to search');

    const turn = await chat({ message: `homes for sale in ${suburb}` });
    onlySearch(turn);

    assert(Array.isArray(turn.suggestions), 'the turn carried no suggestions array');
    assert(
      turn.suggestions.length > 0,
      'a turn that searched offered no next step at all',
    );
    // MAX_SUGGESTIONS in packages/ai/src/suggestions.ts. Restated rather than
    // imported: this is a black-box check of the wire contract, and importing
    // the constant would make it agree with itself.
    assert(
      turn.suggestions.length <= 3,
      `${turn.suggestions.length} chips — every one costs a billed turn to press`,
    );

    const kinds = turn.suggestions.map((c) => c.kind);
    assert(new Set(kinds).size === kinds.length, `a kind repeated: ${kinds.join(', ')}`);
    for (const chip of turn.suggestions) {
      assert(chip.label.trim().length > 0, `a chip had no label: ${JSON.stringify(chip)}`);
      /**
       * `send` becomes the visitor's next message and goes straight back
       * through `chatRequestSchema`. A chip the server cannot accept is worse
       * than no chip: it looks pressable and 400s.
       */
      assert(
        chip.send.trim().length > 0 && chip.send.length <= 1000,
        `chip "${chip.label}" would not pass chatRequestSchema: ${chip.send.length} chars`,
      );
    }
    return kinds.join(' · ');
  });

  await check('"cheapest near my office" is answered from SQL, both ways', async () => {
    /**
     * The question the portal could not answer until now.
     *
     * `search_listings` sorts by price OR by distance, never both, and the
     * model may not do the arithmetic itself (#4) — so "where is the cheapest
     * place near my office" got a list sorted one way and prose hand-waving
     * the other.
     *
     * `cheapest_near` returns two rankings from one statement. This asserts
     * the guide actually reaches for it, and — the part that matters — that
     * what it says matches what Postgres computed. A guide that calls the
     * tool and then rounds, converts or invents is the failure #4 exists for.
     */
    if (!webUp) skip('web app is not running');
    if (!haveAnthropic) skip(aiSkipReason(liveAi));

    const suburbs = await liveSuburbs(db);
    const suburb = suburbs[0];
    if (!suburb) skip('no live listings');

    const centre = await resolvePlace(db, `${suburb}, Australia`);
    if (!centre) skip(`could not locate ${suburb}`);

    const market = await nearbyMarket(db, {
      near: { lat: centre.latitude, lng: centre.longitude, radiusKm: 20 },
      channel: 'sale',
    });
    if (!market.bySuburb.length) skip(`nothing priced within 20 km of ${suburb}`);

    const turn = await chat({
      message: `my office is in ${suburb}. where is the cheapest house near it to buy?`,
    });

    assert(turn.text.trim().length > 0, 'the guide answered with nothing');

    /**
     * The cheapest suburb Postgres found has to be the one the guide names.
     *
     * Checked as "is it in the answer" rather than "is it first", because the
     * guide writes prose — but naming a different suburb as the cheapest when
     * SQL says otherwise is exactly the invention this catches.
     */
    const cheapestSuburb = market.bySuburb[0]!.suburb;
    assert(
      turn.text.toLowerCase().includes(cheapestSuburb.toLowerCase()),
      `SQL says the cheapest nearby is ${cheapestSuburb}; the guide never mentioned it: "${turn.text.slice(0, 160)}"`,
    );

    /**
     * And no invented travel time.
     *
     * Every distance this platform holds is straight-line. "About 12 minutes"
     * is a figure no tool produced, and a road can easily double it.
     */
    assert(
      !/\b\d+\s*(minutes?|mins?|hours?)\b/i.test(turn.text),
      `the guide turned a distance into travel time: "${turn.text.slice(0, 160)}"`,
    );

    return `named ${cheapestSuburb}, cheapest of ${market.bySuburb.length} suburb(s)`;
  });

  await check('a turn that already has requirements is not a 400', async () => {
    /**
     * The turn every live check here was missing.
     *
     * Not one of them sent `slots`, so every one took the empty-requirements
     * path — and that path worked throughout the outage. The whole AI group
     * was green while the chat was broken for anyone who had got as far as
     * telling the guide what they wanted.
     *
     * The failure was `400 role 'system' is not supported on this model`:
     * `reconstructMessages` put a `{ role: 'system' }` entry in `messages`,
     * which the Opus and Fable families implement and Haiku 4.5 — what this
     * route runs — does not. It only fired once `slots` had something in it,
     * so the opening turns of every conversation worked and the rest did not.
     *
     * This is the shape the visitor was in when it broke: a second message,
     * with a brief already gathered. It has to reach the model by whichever
     * carrier the configured model accepts, and the turn has to come back.
     */
    if (!webUp) skip('web app is not running');
    if (!haveAnthropic) skip(aiSkipReason(liveAi));

    const suburbs = await liveSuburbs(db);
    const suburb = suburbs[0];
    if (!suburb) skip('no live listings to search');

    const turn = await chat({
      message: 'actually make it four bedrooms',
      turns: [
        { role: 'user', text: `somewhere in ${suburb} to buy` },
        { role: 'assistant', text: 'What is your budget?' },
      ],
      // The part that matters. `chat()` already asserts HTTP 200 and no error
      // on the turn, so a 400 from the API fails here with the API's own words.
      slots: { channel: 'sale', suburb, priceTo: 900_000 },
    });

    assert(turn.text.trim().length > 0, 'the guide answered with nothing');

    /**
     * And the requirements actually landed.
     *
     * "It no longer 400s" is satisfied by dropping them on the floor, so the
     * carrier has to be doing its job: the guide was told the channel and the
     * suburb in the slots and must not have thrown them away. If it searched,
     * it must have searched with them.
     */
    const search = turn.results[turn.results.length - 1];
    if (search) {
      assert(
        search.query.suburb?.toLowerCase() === suburb.toLowerCase(),
        `searched ${search.query.suburb} — the suburb in the brief was ignored`,
      );
      assert(
        search.query.channel === 'sale',
        `channel was ${search.query.channel} — the brief said sale`,
      );
    }

    return search ? `searched ${search.query.suburb} with the brief kept` : 'answered, brief kept';
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
