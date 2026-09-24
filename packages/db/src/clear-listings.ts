import { config } from 'dotenv';
import { resolve } from 'node:path';
import postgres from 'postgres';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * Remove listings so a surface can be tested from empty.
 *
 * Only listings and the property rows left with nothing pointing at them.
 * Agencies, memberships, users, agent profiles and invites are never touched —
 * the agency here holds the only owner login, and deleting it would lock
 * everybody out of the console to save a few test rows.
 *
 * Everything that belongs to a listing alone goes with it by foreign key
 * cascade: listing_agent, media, inspections, leads.
 *
 *   pnpm --filter @repo/db db:clear-listings            # show what would go
 *   pnpm --filter @repo/db db:clear-listings --confirm  # do it
 */
async function main() {
  const confirmed = process.argv.includes('--confirm');

  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }

  const sql = postgres(url, { prepare: false, max: 1 });

  try {
    const listings = await sql`
      select l.id, l.status, coalesce(l.headline, '(no headline)') as headline,
             p.suburb, p.state, p.postcode
      from listing l join property p on p.id = l.property_id
      order by l.created_at`;

    if (!listings.length) {
      console.log('No listings. Nothing to do.');
      return;
    }

    console.log(`${listings.length} listing(s):\n`);
    for (const l of listings) {
      console.log(`  ${l.status.padEnd(9)} ${l.suburb} ${l.state} ${l.postcode}  — ${l.headline}`);
    }

    if (!confirmed) {
      console.log('\nDry run. Re-run with --confirm to delete these and any orphaned properties.');
      console.log('Agencies, memberships and users are never touched by this script.');
      return;
    }

    // Listings first, then the addresses nothing points at any more. A property
    // still carrying another listing stays: it is the shared physical place,
    // and its history is the reason the two tables are separate.
    const removed = await sql`delete from listing returning id`;
    const orphans = await sql`
      delete from property
      where not exists (select 1 from listing where listing.property_id = property.id)
      returning suburb`;

    console.log(`\nDeleted ${removed.length} listing(s).`);
    console.log(`Deleted ${orphans.length} property row(s) left with no listing.`);

    const kept = await sql`select
      (select count(*) from agency)::int as agencies,
      (select count(*) from membership)::int as memberships,
      (select count(*) from "user")::int as users,
      (select count(*) from agent_profile)::int as profiles`;
    console.log('Untouched:', kept[0]);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
