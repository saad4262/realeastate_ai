import { config } from 'dotenv';
import { resolve } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from './client';
import {
  agency,
  listing,
  listingAgent,
  membership,
  office,
  property,
  user,
} from './schema';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * Optional demo listings for an agency that already exists.
 *
 * It deliberately does NOT create users, memberships or agencies: identity comes from
 * Supabase Auth and agencies are created by registering one at /get-started (ADR 0006).
 * An earlier version invented UUIDs here, which produced app rows no one could sign in as.
 *
 * Usage: `pnpm db:seed` (first agency) or `SEED_AGENCY_SLUG=my-agency pnpm db:seed`.
 */
const DEMO_HEADLINE = 'Sunlit Bondi apartment near the beach';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.includes('YOUR_PASSWORD')) {
    console.error('Set DATABASE_URL with the real password in .env.local before seeding.');
    process.exit(1);
  }

  const db = getDb(databaseUrl);
  const slug = process.env.SEED_AGENCY_SLUG?.trim();

  const [org] = slug
    ? await db.select().from(agency).where(eq(agency.slug, slug)).limit(1)
    : await db.select().from(agency).orderBy(asc(agency.createdAt)).limit(1);

  if (!org) {
    console.error(
      slug
        ? `No agency with slug "${slug}".`
        : 'No agency exists yet.',
    );
    console.error('Sign up in the console and register an agency at /get-started, then re-run.');
    process.exit(1);
  }

  const [firstOffice] = await db
    .select()
    .from(office)
    .where(eq(office.agencyId, org.id))
    .orderBy(asc(office.createdAt))
    .limit(1);

  const existing = await db
    .select({ id: listing.id })
    .from(listing)
    .where(and(eq(listing.agencyId, org.id), eq(listing.headline, DEMO_HEADLINE)))
    .limit(1);

  if (existing[0]) {
    console.log(`Demo listings already present for "${org.name}". Nothing to do.`);
    process.exit(0);
  }

  // Lead agent for listing_agent — an existing member only, never an invented user.
  const members = await db
    .select({
      userId: membership.userId,
      role: membership.role,
      name: user.name,
      email: user.email,
      phone: user.phone,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.agencyId, org.id), eq(membership.status, 'active')));

  const leadAgent = members.find((m) => m.role === 'agent') ?? members[0];

  const [prop] = await db
    .insert(property)
    .values({
      unit: '12',
      streetNumber: '45',
      street: 'Hall St',
      suburb: 'Bondi Beach',
      state: 'NSW',
      postcode: '2026',
      propertyType: 'apartment',
      bedrooms: 2,
      bathrooms: '1.0',
      carSpaces: 1,
      buildingAreaSqm: '78',
      yearBuilt: 1998,
    })
    .returning({ id: property.id });

  if (!prop) throw new Error('Failed to create demo property');

  // price_display AND price_from/price_to are both stored — never parse the string later.
  const rows = await db
    .insert(listing)
    .values([
      {
        propertyId: prop.id,
        agencyId: org.id,
        officeId: firstOffice?.id ?? null,
        channel: 'sale',
        status: 'live',
        priceFrom: '1450000',
        priceTo: '1550000',
        priceDisplay: 'Offers over $1.45m',
        headline: DEMO_HEADLINE,
        description: 'Two-bed apartment with north aspect.',
        source: 'portal',
        publishedAt: new Date(),
      },
      {
        propertyId: prop.id,
        agencyId: org.id,
        officeId: firstOffice?.id ?? null,
        channel: 'sold',
        status: 'sold',
        priceFrom: '1200000',
        priceTo: '1200000',
        priceDisplay: 'Sold $1.20m',
        soldPrice: '1200000',
        soldDate: new Date('2023-06-15'),
        headline: 'Previous sale',
        source: 'portal',
      },
      {
        propertyId: prop.id,
        agencyId: org.id,
        officeId: firstOffice?.id ?? null,
        channel: 'rent',
        status: 'draft',
        rentPw: '950',
        priceDisplay: '$950 per week',
        headline: 'Rental draft',
        source: 'portal',
      },
    ])
    .returning({ id: listing.id, status: listing.status });

  if (leadAgent) {
    await db
      .insert(listingAgent)
      .values(
        rows
          .filter((r) => r.status !== 'draft')
          .map((r) => ({
            listingId: r.id,
            userId: leadAgent.userId,
            role: 'lead' as const,
            displayOrder: 0,
            snapshotName: leadAgent.name ?? leadAgent.email,
            snapshotPhone: leadAgent.phone ?? '',
            snapshotEmail: leadAgent.email,
          })),
      )
      .onConflictDoNothing();
  } else {
    console.warn('No active member found — listings created without a listing_agent link.');
  }

  console.log(`Seeded ${rows.length} demo listings for "${org.name}".`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
