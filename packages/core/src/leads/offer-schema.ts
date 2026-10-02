import { z } from 'zod';
import { enquiryInputSchema } from './lead-schema';

/**
 * What a visitor may send when they make a private offer on an off-market
 * property.
 *
 * Built on `enquiryInputSchema` rather than beside it, so the name, phone and
 * message rules are not re-litigated — in particular the phone field's
 * deliberate lack of a pattern, whose reasoning is written out there.
 *
 * Note what is NOT here, and it is more than the enquiry omits. `propertyId`
 * comes from the page. The agency is resolved from the last sale on the server.
 * `kind`, `status` and `assignedTo` are not the browser's business.
 *
 * And **`email` is omitted outright**, not merely ignored. It comes from the
 * signed-in session, because an unattributable financial approach to a private
 * owner is the one thing this flow must not accept. Leaving the inherited field
 * in place and quietly discarding it was the first shape of this schema, and it
 * was wrong twice over: the form would have had to render a field whose value
 * went nowhere, and a signed-in visitor would have been asked to retype an
 * address the server already knows. A contract should not require what it throws
 * away.
 */
export const privateOfferInputSchema = enquiryInputSchema.omit({ email: true }).extend({
  /**
   * What they are offering, in whole dollars.
   *
   * Coerced, because a form hands over a string. Integer, because cents in a
   * property offer are noise that makes two offers hard to compare at a glance.
   * The ceiling is the same one `listingDraftSchema` uses for a price, so an
   * offer and an asking price cannot disagree about what a plausible number is.
   *
   * Stored and displayed exactly as given. Nothing computes, rounds or estimates
   * it (#4) — it is the visitor's own figure and the agency has to read it back
   * unchanged.
   */
  offerAmount: z.coerce
    .number({ invalid_type_error: 'Enter your offer as a number' })
    .int('Offer in whole dollars')
    .min(1, 'Enter what you are offering')
    .max(1_000_000_000),
});

export type PrivateOfferInput = z.infer<typeof privateOfferInputSchema>;

export type PrivateOfferResult =
  | { ok: true }
  /** `needsSignIn` is its own flag: the page shows a login prompt, not an error. */
  | { ok: false; error: string; field?: keyof PrivateOfferInput; needsSignIn?: true };
