import { config } from 'dotenv';
import { resolve } from 'node:path';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb, property } from '@repo/db';
import { geocodeAddress } from './places';
import { isGeoProviderConfigured } from './provider-google';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * Give coordinates, and the geocoder's own address line, to properties missing
 * either.
 *
 * A listing saves whether or not the geocoder can find its address — that is
 * deliberate, an agent must never be blocked by someone else's outage. The
 * cost is that those properties are invisible to radius search until this runs.
 *
 * Reasons a property ends up here:
 *   - it was created before GOOGLE_MAPS_API_KEY existed
 *   - the provider was down, rate-limited or simply did not recognise it
 *   - it was pinned by hand during development (geocode_source = 'manual')
 *
 * Safe to run repeatedly: already-geocoded rows are skipped unless --redo is
 * passed, and every lookup goes through place_cache, so a second run over the
 * same addresses costs nothing.
 *
 * It lives in @repo/core rather than @repo/db because it needs the geocoder,
 * and @repo/core already depends on @repo/db — the other direction would be a
 * cycle.
 *
 *   pnpm --filter @repo/core geo:backfill
 *   pnpm --filter @repo/core geo:backfill --redo     # replace hand-placed pins
 *   pnpm --filter @repo/core geo:backfill --dry-run
 */
async function main() {
  const redo = process.argv.includes('--redo');
  const dryRun = process.argv.includes('--dry-run');

  if (!isGeoProviderConfigured()) {
    console.error(
      'GOOGLE_MAPS_API_KEY is not set. Nothing to do — set it in .env.local and re-run.',
    );
    process.exitCode = 1;
    return;
  }

  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }

  const db = getDb(url);

  // --redo also takes the rows a human pinned, which is the point of it: those
  // are approximations standing in for a geocoder that was not available yet.
  // A row pinned before `formatted_address` existed is picked up too: it has
  // coordinates but nothing saying which address they belong to, and every
  // lookup is a cache hit, so re-asking for it is free.
  const where = redo
    ? or(isNull(property.latitude), eq(property.geocodeSource, 'manual'))!
    : or(isNull(property.latitude), isNull(property.formattedAddress))!;

  const rows = await db
    .select({
      id: property.id,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
      source: property.geocodeSource,
    })
    .from(property)
    .where(and(where));

  if (!rows.length) {
    console.log('Nothing to geocode.');
    return;
  }

  console.log(`${rows.length} propert${rows.length === 1 ? 'y' : 'ies'} to geocode${dryRun ? ' (dry run)' : ''}.\n`);

  let done = 0;
  let missed = 0;

  for (const row of rows) {
    const label = [row.streetNumber, row.street, row.suburb, row.state, row.postcode]
      .filter(Boolean)
      .join(' ');

    const hit = await geocodeAddress(db, {
      unit: row.unit,
      streetNumber: row.streetNumber,
      street: row.street,
      suburb: row.suburb,
      state: row.state,
      postcode: row.postcode,
    });

    if (!hit) {
      // Left alone rather than blanked: a hand-placed pin is better than none,
      // and a provider that cannot find an address today may tomorrow.
      console.log(`  miss  ${label}`);
      missed += 1;
      continue;
    }

    if (hit.kind !== 'address') {
      // The geocoder found the suburb, or the state, but not this address.
      // Storing that as the property's pin puts it at a centroid it has no
      // relationship to and into radius searches it does not belong in —
      // which is how a Sahiwal address ended up in the middle of NSW.
      console.log(`  coarse ${label} → only matched a ${hit.kind}; left unpinned`);
      missed += 1;
      continue;
    }

    if (!dryRun) {
      await db
        .update(property)
        .set({
          latitude: hit.latitude.toFixed(6),
          longitude: hit.longitude.toFixed(6),
          placeId: hit.placeId,
          formattedAddress: hit.formatted,
          geocodedAt: new Date(),
          geocodeSource: 'google',
          updatedAt: sql`now()`,
        })
        .where(eq(property.id, row.id));
    }

    const was = row.source === 'manual' ? ' (was a hand-placed pin)' : '';
    console.log(`  ok    ${label} → ${hit.latitude.toFixed(5)}, ${hit.longitude.toFixed(5)}${was}`);
    done += 1;
  }

  console.log(`\n${done} geocoded, ${missed} not pinned.`);
  if (missed) {
    console.log('Not-found addresses keep whatever they had and can be re-run later.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  // postgres.js holds the process open on an idle pool.
  .finally(() => process.exit());
