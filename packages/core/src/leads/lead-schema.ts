import { z } from 'zod';

/**
 * What a visitor may send when they enquire about a listing.
 *
 * Note what is NOT here: listingId is taken from the page, agencyId is looked
 * up from that listing on the server, and status, kind, assignedTo and
 * aiSummary are not the browser's business at all. An enquiry form that
 * accepted an agencyId would let anyone file a lead into any agency's inbox.
 */
export const enquiryInputSchema = z.object({
  name: z.string().trim().min(2, 'Please give a name').max(120),
  email: z.string().trim().email('That does not look like an email address').max(200),
  /**
   * Optional, and deliberately not validated into a shape. Australian numbers
   * are written a dozen ways — 0412 884 920, +61 412 884 920, (03) 5941 1234 —
   * and a regex that refuses a real number a buyer typed correctly costs an
   * agency a lead. Length is the only thing worth enforcing.
   */
  phone: z.string().trim().max(40).optional(),
  message: z.string().trim().min(10, 'Tell the agent a little more').max(2000),
});

export type EnquiryInput = z.infer<typeof enquiryInputSchema>;

export type EnquiryResult =
  | { ok: true }
  | { ok: false; error: string; field?: keyof EnquiryInput };
