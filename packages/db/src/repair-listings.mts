import { config } from 'dotenv';
import { resolve } from 'node:path';
import postgres from 'postgres';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * Bring existing rows up to the listing contract, without inventing anything.
 *
 * Validation was tightened after these rows were written, so they were legal
 * when they were saved and are not now. `pnpm smoke` reports them; this fixes
 * the kinds of damage that can be fixed from data already in the database.
 *
 * The rule it follows is the whole point of it: every repair is either
 * DERIVED from something true, or is an honest "unknown". Nothing here makes
 * up a price, because a made-up price on a property listing is a worse
 * problem than the one it replaces.
 *
 *   headline is not a phrase   -> built from the property itself, e.g.
 *                                 "3-bedroom house in Pakenham". Every word of
 *                                 that came out of the property row.
 *
 *   priceDisplay is bare digits -> set to NULL. The string is copy for a buyer
 *                                 and this one is not copy; it also disagreed
 *                                 with the searchable range beside it (one read
 *                                 as $23m against a range starting at $34,443).
 *                                 It cannot be repaired by parsing it — #6 —
 *                                 so the untrustworthy string goes and the
 *                                 structured numbers, which is what search
 *                                 actually filters on, stay. The card falls
 *                                 back to formatting those.
 *
 *   23 bedrooms / 32 bathrooms -> set to NULL. We know the number is wrong.
 *                                 We do not know the right one, and "unknown"
 *                                 is the true statement. It renders as "—".
 *
 *   property_type is not in the  -> set to NULL. It was a free text box, so
 *   vocabulary                     "sfd" and "2jkads" were sitting in the
 *                                  column that the PUBLIC SEARCH FILTER builds
 *                                  its dropdown from. "House" is only a
 *                                  capitalisation away and is normalised
 *                                  rather than dropped.
 *
 * Idempotent: a row that already satisfies the contract is not touched, so
 * running it twice changes nothing the second time.
 *
 * Usage: `pnpm db:repair-listings` to see what it would do,
 *        `pnpm db:repair-listings --write` to do it.
 */

const MAX_ROOMS = 20;
const MIN_HEADLINE = 10;

/** Mirrors PROPERTY_TYPES in packages/core. packages/db cannot import core — it
 *  is the layer underneath it — so this is the one deliberate copy, and the
 *  smoke check "every live listing still satisfies the listing contract" asks
 *  the real schema rather than this list. */
const PROPERTY_TYPES = [
  'house', 'apartment', 'unit', 'townhouse', 'villa', 'duplex',
  'studio', 'acreage', 'land', 'rural', 'other',
];

const isPhrase = (v: string | null) =>
  v !== null && v.trim().length >= MIN_HEADLINE && /\S\s+\S/.test(v.trim());

/** Copy a buyer reads, rather than a naked number. Mirrors priceDisplaySchema. */
const isPriceCopy = (v: string | null) => v === null || /[A-Za-z$]/.test(v);

function headlineFrom(r: {
  bedrooms: number | null;
  property_type: string | null;
  suburb: string;
}): string {
  // Only a type from the vocabulary. The first draft of this built
  // "3-bedroom sfd in Nar Nar Goon North" and "2jkads in Pakenham", because it
  // trusted a column that turned out to hold the same class of junk it was
  // repairing. A repair is only as good as the field it reads.
  const kind = r.property_type ?? 'home';
  const beds = r.bedrooms !== null && r.bedrooms > 0 && r.bedrooms <= MAX_ROOMS
    ? `${r.bedrooms}-bedroom `
    : '';
  const line = `${beds}${kind} in ${r.suburb}`;
  return line.charAt(0).toUpperCase() + line.slice(1);
}

const write = process.argv.includes('--write');

const url = process.env.DATABASE_URL;
if (!url || url.includes('YOUR_PASSWORD')) {
  console.error('Set DATABASE_URL with the real password in .env.local first.');
  process.exit(1);
}

const sql = postgres(url, { prepare: false });

const rows = await sql<
  {
    id: string;
    property_id: string;
    status: string;
    channel: string;
    headline: string | null;
    price_display: string | null;
    price_from: string | null;
    price_to: string | null;
    bedrooms: number | null;
    bathrooms: string | null;
    car_spaces: number | null;
    property_type: string | null;
    suburb: string;
  }[]
>`
  select l.id, l.property_id, l.status, l.channel, l.headline, l.price_display,
         l.price_from, l.price_to,
         p.bedrooms, p.bathrooms, p.car_spaces, p.property_type, p.suburb
  from listing l join property p on p.id = l.property_id
  order by l.created_at desc
`;

let touched = 0;

for (const r of rows) {
  const listingPatch: Record<string, unknown> = {};
  const propertyPatch: Record<string, unknown> = {};
  const notes: string[] = [];

  // Worked out first: the headline is derived from both of these, and it must
  // never be built out of a value that is about to be thrown away.
  const normalisedType = r.property_type?.trim().toLowerCase() ?? null;
  const typeOk = normalisedType !== null && PROPERTY_TYPES.includes(normalisedType);
  const repairedType = typeOk ? normalisedType : null;
  const repairedBeds = r.bedrooms !== null && r.bedrooms > MAX_ROOMS ? null : r.bedrooms;

  if (normalisedType !== r.property_type) {
    propertyPatch.property_type = repairedType;
    notes.push(
      typeOk
        ? `property_type ${JSON.stringify(r.property_type)} -> ${JSON.stringify(repairedType)} (one spelling per type)`
        : `property_type ${JSON.stringify(r.property_type)} -> NULL (not a property type; it was in the public filter dropdown)`,
    );
  } else if (!typeOk && r.property_type !== null) {
    propertyPatch.property_type = null;
    notes.push(
      `property_type ${JSON.stringify(r.property_type)} -> NULL (not a property type; it was in the public filter dropdown)`,
    );
  }

  if (!isPhrase(r.headline)) {
    listingPatch.headline = headlineFrom({
      bedrooms: repairedBeds,
      property_type: repairedType,
      suburb: r.suburb,
    });
    notes.push(`headline ${JSON.stringify(r.headline)} -> ${JSON.stringify(listingPatch.headline)}`);
  }

  if (!isPriceCopy(r.price_display)) {
    listingPatch.price_display = null;
    notes.push(
      `price_display ${JSON.stringify(r.price_display)} -> NULL ` +
        `(range ${r.price_from ?? 'null'}..${r.price_to ?? 'null'} kept — it is what search uses)`,
    );
  }

  if (r.bedrooms !== null && r.bedrooms > MAX_ROOMS) {
    propertyPatch.bedrooms = null;
    notes.push(`bedrooms ${r.bedrooms} -> NULL (wrong, and the truth is not in the database)`);
  }
  if (r.bathrooms !== null && Number(r.bathrooms) > MAX_ROOMS) {
    propertyPatch.bathrooms = null;
    notes.push(`bathrooms ${r.bathrooms} -> NULL`);
  }
  if (r.car_spaces !== null && r.car_spaces > MAX_ROOMS) {
    propertyPatch.car_spaces = null;
    notes.push(`car_spaces ${r.car_spaces} -> NULL`);
  }

  if (!notes.length) continue;
  touched++;

  console.log(`\n${r.id.slice(0, 8)} [${r.status}/${r.channel}] ${r.suburb}`);
  for (const n of notes) console.log(`   ${n}`);

  if (!write) continue;

  // Two statements, one transaction: a listing left with a repaired headline
  // over a property that still claims 32 bathrooms is a worse state than
  // either of the two it sits between.
  await sql.begin(async (tx) => {
    if (Object.keys(listingPatch).length) {
      await tx`update listing set ${tx(listingPatch)} where id = ${r.id}`;
    }
    if (Object.keys(propertyPatch).length) {
      await tx`update property set ${tx(propertyPatch)} where id = ${r.property_id}`;
    }
  });
}

console.log(
  touched === 0
    ? `\nNothing to repair — all ${rows.length} listing(s) satisfy the contract.`
    : write
      ? `\nRepaired ${touched} of ${rows.length} listing(s).`
      : `\n${touched} of ${rows.length} listing(s) would be repaired. Re-run with --write to apply.`,
);

await sql.end();
