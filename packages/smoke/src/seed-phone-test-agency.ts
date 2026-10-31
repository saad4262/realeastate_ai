import { config } from 'dotenv';
import { resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { agency, agentProfile, contact, getDb, listing, membership, user, type Db } from '@repo/db';
import type { Actor } from '@repo/core/permissions';
import { createBuyerRequirement, createContact, linkContactProperty } from '@repo/core/contacts';
import { createListing, setListingStatus } from '@repo/core/listings';
import { createEnquiry } from '@repo/core/leads';
import { scheduleAppointment } from '@repo/core/appointments';
import { createTemplate } from '@repo/core/template-email';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * Data for the manual walk of TEST-PLAN BN, BO, BQ, BR and BS on the phone test agency — and ONLY that
 * agency: it is found by its slug, its name is checked, and every write goes through core as that agency's
 * owner (or is scoped to its id). The database is shared with production, so:
 *   - every email is an alias of one inbox the tester reads (checked before anything is written);
 *   - every phone number is from ACMA's range reserved for fiction (0491 570 xxx), so no text reaches anyone;
 *   - every pin is given, so no geocoder is called; no email or text is sent by this script;
 *   - a listing is only created at an address no property row has yet (property rows are shared by every
 *     agency, and creating a listing rewrites the row's pin and facts).
 *
 * Idempotent: a contact is found by its email, a listing by its headline, the template by its name.
 *
 * Usage (from packages/smoke): `pnpm exec tsx src/seed-phone-test-agency.ts`
 */
const AGENCY_SLUG = 'phone-test-agency-20261030-dev';
const AGENCY_NAME_MUST_HAVE = 'Phone Test Agency';
const TAG = '(TEST)';
const alias = (tag: string) => `alphaedgetechnologylabs+pt-${tag}@gmail.com`;
const ALIAS_RE = /^alphaedgetechnologylabs\+pt-[a-z0-9-]+@gmail\.com$/;

type ListingSeed = { key: string; status: 'live' | 'draft'; property: Record<string, unknown>; listing: Record<string, unknown> };
const LISTINGS: ListingSeed[] = [
  {
    key: 'lakeside',
    status: 'live',
    // A made-up street: the property table is shared by every agency, so a real address would rewrite
    // another agency's pin and facts (it did once — 27 Lakeside Blvd, Alpha's listing, 2026-10-31).
    property: { streetNumber: '1', street: 'Testing Way', suburb: 'Pakenham', state: 'VIC', postcode: '3810', propertyType: 'house', bedrooms: 3, bathrooms: 2, carSpaces: 2, latitude: -38.0745, longitude: 145.4801 },
    listing: { channel: 'sale', headline: `${TAG} Family home by the lake`, description: 'Test listing for manual QA (BN, BQ, BS). Three bedrooms, two bathrooms, double garage.', priceDisplay: '$765,000 - $785,000', priceFrom: 765000, priceTo: 785000 },
  },
  {
    key: 'station',
    status: 'live',
    property: { streetNumber: '14', street: 'Station St', suburb: 'Officer', state: 'VIC', postcode: '3809', propertyType: 'house', bedrooms: 4, bathrooms: 2, carSpaces: 2, latitude: -38.0596, longitude: 145.41 },
    listing: { channel: 'sale', headline: `${TAG} Four bedrooms near the station`, description: 'Test listing for manual QA (BQ3–BQ8, BR). Mark it sold at $782,000 in the walk.', priceDisplay: '$760,000 - $800,000', priceFrom: 760000, priceTo: 800000 },
  },
  {
    key: 'rosewood',
    status: 'draft',
    property: { streetNumber: '8', street: 'Rosewood Ct', suburb: 'Pakenham', state: 'VIC', postcode: '3810', propertyType: 'house', bedrooms: 3, bathrooms: 1, carSpaces: 1, latitude: -38.0789, longitude: 145.4712 },
    listing: { channel: 'sale', headline: `${TAG} Starter home on a quiet court`, description: 'Test listing for manual QA (BN8: a draft listing).', priceDisplay: '$700,000 - $740,000', priceFrom: 700000, priceTo: 740000 },
  },
];

/** Briefs that fit Lakeside (3 bed house, Pakenham, $765k–$785k). */
const FITS_LAKESIDE = { channel: 'sale' as const, priceMin: 700000, priceMax: 800000, minBedrooms: 3, suburbs: ['Pakenham', 'Officer'], propertyTypes: ['house'] };

type ContactSeed = {
  key: string;
  name: string;
  phone: string;
  roles: ('buyer' | 'seller' | 'past_client')[];
  consent?: string;
  brief?: boolean;
  unsubscribed?: boolean;
};
const CONTACTS: ContactSeed[] = [
  { key: 'amira', name: `Amira Buyer ${TAG}`, phone: '0491 570 006', roles: ['buyer'], consent: 'Asked for new listings at an open home (test data)', brief: true },
  { key: 'ben', name: `Ben Brief ${TAG}`, phone: '0491 570 156', roles: ['buyer'], brief: true },
  { key: 'chloe', name: `Chloe Unsubscribed ${TAG}`, phone: '0491 570 157', roles: ['buyer'], brief: true, unsubscribed: true },
  { key: 'owen', name: `Owen Owner ${TAG}`, phone: '0491 570 158', roles: ['seller'] },
  { key: 'priya', name: `Priya Pastclient ${TAG}`, phone: '0491 570 159', roles: ['past_client'] },
];
const ENQUIRER = { key: 'ella', name: `Ella Enquirer ${TAG}`, phone: '0491 570 110' };

async function findAgency(db: Db) {
  const [ag] = await db.select({ id: agency.id, name: agency.name }).from(agency).where(eq(agency.slug, AGENCY_SLUG)).limit(1);
  if (!ag) throw new Error(`No agency with slug ${AGENCY_SLUG} — nothing written`);
  if (!ag.name.includes(AGENCY_NAME_MUST_HAVE)) throw new Error(`Agency ${AGENCY_SLUG} is named "${ag.name}" — not the test agency, nothing written`);
  const members = await db
    .select({ userId: membership.userId, role: membership.role, email: user.email })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.agencyId, ag.id), eq(membership.status, 'active')));
  const owner = members.find((m) => m.role === 'owner');
  const agent = members.find((m) => m.role === 'agent');
  if (!owner || !agent) throw new Error('The test agency needs an active owner and an active agent — nothing written');
  for (const m of [owner, agent]) {
    if (!m.email.startsWith('phone-test-')) throw new Error(`Member ${m.email} is not a phone test account — nothing written`);
  }
  return { agencyId: ag.id, name: ag.name, owner, agent };
}

/**
 * Refuse an address any property row already has — wider than core's own matching on purpose (same
 * suburb, postcode and number, and the street's first word), so a "Blvd"/"Boulevard" spelling cannot slip by.
 */
async function assertAddressUnused(db: Db, p: Record<string, unknown>): Promise<void> {
  const [hit] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from property
    where lower(trim(suburb)) = lower(${String(p.suburb)}) and postcode = ${String(p.postcode)}
      and street_number = ${String(p.streetNumber)}
      and lower(split_part(trim(street), ' ', 1)) = lower(split_part(${String(p.street)}, ' ', 1))`);
  if (hit?.n) throw new Error(`${p.streetNumber} ${p.street}, ${p.suburb} is already a property row (perhaps another agency's) — pick a made-up address; nothing written for it`);
}

async function contactByEmail(db: Db, agencyId: string, email: string): Promise<string | null> {
  const [row] = await db.select({ id: contact.id }).from(contact).where(and(eq(contact.agencyId, agencyId), eq(contact.email, email))).limit(1);
  return row?.id ?? null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing');
  const db = getDb(url);

  // Every address checked before the first write.
  const emails = [...CONTACTS.map((c) => alias(c.key)), alias(ENQUIRER.key)];
  const bad = emails.filter((e) => !ALIAS_RE.test(e));
  if (bad.length) throw new Error(`Refusing: not a tester alias: ${bad.join(', ')}`);

  const t = await findAgency(db);
  const owner: Actor = { userId: t.owner.userId, agencyId: t.agencyId, membershipRole: 'owner' };
  const out: string[] = [`${t.name}`, `  owner ${t.owner.email}`, `  agent ${t.agent.email}`];

  // Listings, all with the test agent named.
  const made: Record<string, { id: string; propertyId: string }> = {};
  for (const seed of LISTINGS) {
    const headline = seed.listing.headline as string;
    let [row] = await db
      .select({ id: listing.id, propertyId: listing.propertyId, status: listing.status })
      .from(listing)
      .where(and(eq(listing.agencyId, t.agencyId), eq(listing.headline, headline)))
      .limit(1);
    if (!row) {
      await assertAddressUnused(db, seed.property);
      const r = await createListing(db, owner, {
        property: { ...seed.property, pinSource: 'manual' },
        listing: seed.listing,
        agentUserIds: [t.agent.userId],
      });
      row = { id: r.listingId, propertyId: r.propertyId, status: r.status };
    }
    if (seed.status === 'live' && row.status === 'draft') await setListingStatus(db, owner, row.id, 'live');
    made[seed.key] = { id: row.id, propertyId: row.propertyId };
    out.push(`  listing ${seed.status.padEnd(5)} ${headline}`);
  }

  // Contacts, assigned to the agent.
  const ids: Record<string, string> = {};
  for (const c of CONTACTS) {
    const email = alias(c.key);
    let id = await contactByEmail(db, t.agencyId, email);
    if (!id) {
      ({ id } = await createContact(db, owner, {
        name: c.name,
        email,
        phone: c.phone,
        roles: c.roles,
        assignedTo: t.agent.userId,
        marketingConsent: Boolean(c.consent),
        marketingConsentNote: c.consent,
      }));
      if (c.brief) await createBuyerRequirement(db, owner, id, FITS_LAKESIDE);
    }
    if (c.unsubscribed) {
      await db
        .update(contact)
        .set({ emailOptOutAt: sql`coalesce(${contact.emailOptOutAt}, now())` })
        .where(and(eq(contact.id, id), eq(contact.agencyId, t.agencyId)));
    }
    ids[c.key] = id;
    const notes = [c.roles.join('+'), c.consent ? 'consent' : 'no consent', c.brief ? 'brief' : null, c.unsubscribed ? 'unsubscribed' : null].filter(Boolean);
    out.push(`  contact ${c.name.padEnd(28)} ${email}  (${notes.join(', ')})`);
  }

  // Owen owns Lakeside (BS: People tab).
  await linkContactProperty(db, owner, ids.owen!, { propertyId: made.lakeside!.propertyId, relation: 'owner' }).catch((e: Error) => {
    if (!/already/i.test(e.message)) throw e;
  });

  // An enquiry on Lakeside from the public form's path (no email is sent by createEnquiry).
  const ellaEmail = alias(ENQUIRER.key);
  const [hasLead] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from lead where agency_id = ${t.agencyId} and listing_id = ${made.lakeside!.id} and email = ${ellaEmail}`,
  );
  if (!hasLead?.n) {
    await createEnquiry(db, made.lakeside!.id, {
      name: ENQUIRER.name,
      email: ellaEmail,
      phone: ENQUIRER.phone,
      message: 'Hi, is the vendor open to offers? Could we inspect on Saturday morning? (test data)',
    });
  }
  out.push(`  enquiry ${ENQUIRER.name} on Lakeside  ${ellaEmail}`);

  // An appraisal at Lakeside with Owen, next Tuesday 10:00 Melbourne time (BS: Appraisals & visits). No reminder.
  const title = `${TAG} Appraisal at 1 Testing Way`;
  const [hasAppt] = await db.execute<{ n: number }>(sql`select count(*)::int as n from appointment where agency_id = ${t.agencyId} and title = ${title}`);
  if (!hasAppt?.n) {
    const start = nextTuesdayAt10Melbourne();
    await scheduleAppointment(db, owner, ids.owen!, {
      title,
      type: 'appraisal',
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
      timezone: 'Australia/Melbourne',
      propertyId: made.lakeside!.propertyId,
      assignedAgentId: t.agent.userId,
      reminderMinutes: null,
    });
  }
  out.push(`  appraisal ${title}`);

  // One agency-wide template for "Email them" (BN4–BN8).
  const tplName = `${TAG} New listing for your brief`;
  const [hasTpl] = await db.execute<{ n: number }>(sql`select count(*)::int as n from email_template where agency_id = ${t.agencyId} and name = ${tplName}`);
  if (!hasTpl?.n) {
    await createTemplate(db, owner, {
      name: tplName,
      subject: 'A home at {{listing_address}} that fits your brief',
      body: 'Hi {{first_name}},\n\n{{listing_address}} has just come up and it fits what you told us you are looking for. Guide: {{listing_price}}.\n\nSee it here: {{listing_link}}\n\n{{agent_name}}\n{{agency_name}}',
    });
  }
  out.push(`  template ${tplName}`);

  // The agent's profile split 60/40 (BR), only if the agent already has a profile.
  const upd = await db
    .update(agentProfile)
    .set({ commissionSplitAgent: 60, commissionSplitAgency: 40 })
    .where(eq(agentProfile.userId, t.agent.userId))
    .returning({ id: agentProfile.id });
  out.push(upd.length ? '  agent profile split 60/40' : '  agent has no profile: set the 60/40 split in Agents & Team for BR');

  console.log(out.join('\n'));
  console.log('\nNext: pnpm exec tsx src/sync-test-deals.ts  (opens the deals for these listings)');
  process.exit(0);
}

/** Next Tuesday 10:00 in Melbourne (AEDT, UTC+11 in summer), as a Date. */
function nextTuesdayAt10Melbourne(): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const add = ((2 - d.getUTCDay() + 7) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + add);
  d.setUTCHours(10 - 11, 0, 0, 0);
  return d;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
