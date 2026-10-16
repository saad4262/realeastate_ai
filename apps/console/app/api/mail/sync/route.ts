import { revalidatePath } from 'next/cache';
import { NextResponse, after } from 'next/server';
import { pullReceivedMail } from '@repo/core/mail';
import { getConsoleDb } from '../../../../lib/db';
import { actionUserId } from '../../../../lib/auth-account';

/**
 * Pull new mail from Resend (core `pullReceivedMail`). The inbox calls this
 * while it is open, so a buyer's Gmail reply shows up without a webhook — which
 * is what makes inbound work on localhost and before DNS is set up.
 *
 * At most once per 10 s per server process however many tabs ask (60 s once the
 * webhook is set up, ADR 0035, when this is only the backstop): a ceiling on
 * requests to Resend, not a security control. Any signed-in console member may
 * trigger it; it reads nothing back to them except a count, and what it stores
 * is shown only through can().
 *
 * A POST route, not a Server Action, because the inbox polls it — see
 * api/live/route.ts for what a polled action did to navigation.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LAST_PULL = ((globalThis as { __mailPull?: { at: number } }).__mailPull ??= { at: 0 });

export async function POST() {
  if (!(await actionUserId())) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const gap = process.env.RESEND_WEBHOOK_SECRET?.trim() ? 60_000 : 10_000;
  if (Date.now() - LAST_PULL.at < gap) return NextResponse.json({ stored: 0, configured: true });
  LAST_PULL.at = Date.now();

  const result = await pullReceivedMail({ db: getConsoleDb });
  if (!result.ok) return NextResponse.json({ stored: 0, configured: result.reason !== 'not_configured' });
  if (result.followUp) after(result.followUp);
  if (result.stored > 0) {
    revalidatePath('/inbox');
    revalidatePath('/my-inbox');
  }
  return NextResponse.json({ stored: result.stored, configured: true });
}
