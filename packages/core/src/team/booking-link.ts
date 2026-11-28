import { eq, sql } from 'drizzle-orm';
import { user, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';

/** ADR 0107: each person's own booking page — `{{booking_link}}` in a template. Their own connector: only they set it. */
export const BOOKING_URL_MAX = 300;

/** The link as typed, checked: https only, a real address, not too long. Empty means "none". Pure. */
export function parseBookingUrl(raw: string | null | undefined): { ok: true; url: string | null } | { ok: false; error: string } {
  const v = (raw ?? '').trim();
  if (!v) return { ok: true, url: null };
  if (v.length > BOOKING_URL_MAX) return { ok: false, error: `Keep the link under ${BOOKING_URL_MAX} characters` };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { ok: false, error: 'That is not a web address' };
  }
  if (u.protocol !== 'https:' || !u.hostname.includes('.')) return { ok: false, error: 'Use an https:// link, like https://calendly.com/your-name' };
  return { ok: true, url: u.toString() };
}

const ownConnector = (actor: Actor) => ({ type: 'integration', agencyId: actor.agencyId ?? '', integrationOwnerType: 'user' as const, ownerId: actor.userId });

export class BookingLinkError extends Error {
  constructor(
    readonly code: 'forbidden' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

/** May this person change their own booking link? (Read-only members may not.) */
export function mayEditBookingLink(actor: Actor): boolean {
  return Boolean(actor.agencyId) && can(actor, 'integration:manage', ownConnector(actor));
}

export async function getBookingLink(db: DbOrTx, actor: Actor): Promise<string | null> {
  if (!actor.agencyId || !can(actor, 'integration:read', ownConnector(actor))) return null;
  const [r] = await db.select({ url: user.bookingUrl }).from(user).where(eq(user.id, actor.userId)).limit(1);
  return r?.url ?? null;
}

/** Set (or clear, with an empty value) this person's booking link. Read-only members may not. */
export async function setBookingLink(db: DbOrTx, actor: Actor, raw: string | null): Promise<string | null> {
  if (!mayEditBookingLink(actor)) throw new BookingLinkError('forbidden', 'You may not change this');
  const p = parseBookingUrl(raw);
  if (!p.ok) throw new BookingLinkError('invalid', p.error);
  await db.update(user).set({ bookingUrl: p.url, updatedAt: sql`now()` }).where(eq(user.id, actor.userId));
  return p.url;
}
