import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { lead, listing, type DbOrTx } from '@repo/db';
import { HISTORY_ORDER_SQL, ON_MARKET_STATUSES } from '../listings/listing-detail';
import { privateOfferInputSchema, type PrivateOfferInput } from './offer-schema';

/**
 * The same table again, under another name.
 *
 * The outer query is already `FROM listing` picking the last sale, so the
 * "is anything here on the market" subquery needs its own alias or the two
 * would be the same row.
 */
const onMarket = alias(listing, 'on_market');

export class OfferError extends Error {
  readonly field?: keyof PrivateOfferInput;
  constructor(message: string, field?: keyof PrivateOfferInput) {
    super(message);
    this.name = 'OfferError';
    this.field = field;
  }
}

/**
 * Who is making the offer, as the server knows them.
 *
 * Not a form field. `userId` and `email` come from the session, which is the
 * whole reason this flow requires sign-in: an offer is a financial approach to a
 * private owner, and it has to be attributable to an account. The visitor still
 * types a name and a phone number — those are contact details for this
 * approach, the same way `listing_agent` snapshots the number that was on an ad.
 */
export type Offerer = {
  userId: string;
  email: string;
};

/**
 * Record a private offer on a property that is not on the market.
 *
 * ## One statement, and why it is not two
 *
 * `createEnquiry` reads the listing and then inserts, which leaves a window
 * between "this listing is live" and the write. The equivalent window here is
 * worse: a listing goes live in between, and an offer lands on a property that
 * is now on the market — routed to whoever sold it last rather than to the
 * agency currently selling it, on a page that should have stopped existing. That
 * is precisely what the history-visibility requirement is for, so the check and
 * the write are the same statement and Postgres decides.
 *
 * The `SELECT` feeding the `INSERT` does three things at once: finds the most
 * recent sale at this address, refuses if anything there is on the market, and
 * carries the property and agency ids straight from that row into the new lead.
 * Nothing about the destination comes from the caller.
 *
 * ## What zero rows means, and why the message does not say
 *
 * No such property, no sale ever recorded, or something is on the market. All
 * three are refused with one sentence. Telling them apart would let somebody
 * feeding uuids in learn which addresses exist and which are quietly for sale —
 * the same reasoning as `createEnquiry` refusing to confirm a draft.
 *
 * ## Why it does not send the email
 *
 * A network call must not happen inside a database write, and the ordering
 * matters beyond that: an offer recorded with no email sent can be recovered
 * from the row, while an email sent with no row cannot. So this returns the
 * agency it resolved and the caller notifies afterwards.
 *
 * It returns the PARSED offer with it, so the notification is written from the
 * same trimmed, coerced values that were stored rather than from the caller's
 * raw input. Reading the unknown a second time is how an email ends up quoting
 * an untrimmed name or a string where the row holds a number.
 */
export async function createPrivateOffer(
  db: DbOrTx,
  propertyId: string,
  offeredBy: Offerer,
  input: unknown,
): Promise<{ leadId: string; agencyId: string; offer: PrivateOfferInput }> {
  const parsed = privateOfferInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new OfferError(
      first?.message ?? 'Check the highlighted fields',
      first?.path[0] as keyof PrivateOfferInput | undefined,
    );
  }

  const offer = parsed.data;

  /**
   * Written by hand, because drizzle's builder will not take an ordered,
   * limited `SELECT` as the source of an `INSERT`. Two things make that safe:
   *
   * `ORDER BY` comes from `HISTORY_ORDER_SQL`, the same expression the public
   * timeline orders on — so the agency this offer reaches is the one the page
   * credits at the top of its history, and it cannot drift.
   *
   * Every parameter is cast. In an `INSERT ... SELECT` Postgres has no target
   * column to infer a bare placeholder's type from and fails with "could not
   * determine data type". The enum casts also mean `kind` and `status` are fixed
   * in the statement itself, one level below anywhere a caller could reach.
   */
  const rows = await db.execute<{ id: string; agency_id: string }>(sql`
    insert into lead
      (property_id, agency_id, listing_id, user_id,
       name, email, phone, message, kind, status, offer_amount)
    select
      ${listing.propertyId},
      ${listing.agencyId},
      -- Null: this approach came through no advertisement.
      null::uuid,
      ${offeredBy.userId}::uuid,
      ${offer.name}::text,
      ${offeredBy.email}::text,
      ${offer.phone ?? null}::text,
      ${offer.message}::text,
      'offer'::lead_kind,
      'new'::lead_status,
      ${offer.offerAmount}::numeric
    from ${listing}
    where ${and(
      eq(listing.propertyId, propertyId),
      /** The sale is what makes this address approachable at all. */
      eq(listing.status, 'sold'),
      /**
       * And nothing at this address may be on the market. Correlated on the id
       * the caller gave rather than on the outer row, so it does not depend on
       * which sale won the ordering.
       */
      notExists(
        db
          .select({ one: sql`1` })
          .from(onMarket)
          .where(
            and(
              eq(onMarket.propertyId, propertyId),
              inArray(onMarket.status, [...ON_MARKET_STATUSES]),
            ),
          ),
      ),
    )}
    order by ${HISTORY_ORDER_SQL}
    limit 1
    returning id, agency_id
  `);

  const row = rows[0];
  if (!row) {
    // One sentence for all three refusals — see the note above.
    throw new OfferError('That property is not open to private offers');
  }

  return { leadId: row.id, agencyId: row.agency_id, offer };
}
