import { and, eq, isNull, sql } from 'drizzle-orm';
import { activity, agency, appointment, contact, mailThread, type Db } from '@repo/db';
import type { Actor } from '../permissions';
import { checkEmailLimits, devAllowlistProblem, emailLimitsFromEnv, type EmailLimitCheck, type EmailLimits } from '../email/limits';
import { deliverOutbound, recordOutbound, type MailDeps } from '../mail/send';
import { resolveSender, senderLine } from '../mail/sender';
import { recordActivity } from '../contacts/write-contacts';
import { formatInZone } from '../time/local-input';
import { APPOINTMENT_TYPE_LABELS, contactNoticeFor, type ContactNotice } from './appointment-schema';
import { AppointmentError, getAppointment, type AppointmentView } from './appointments';

/**
 * The emails to an appointment's contact (ADR 0019) — never automatic. The
 * agent sees exactly what will be sent (`previewInvitation`) and presses Send
 * (`sendInvitation`). Which email it is follows from the appointment
 * (`contactNoticeFor`):
 *  - the invitation, the first time;
 *  - "Updated", when they were emailed before and it has since moved (a move
 *    clears `invitation_sent_at`, so they would otherwise keep the old time and
 *    get no reminder for the new one);
 *  - "Cancelled", when they were emailed before and it was cancelled (its Zoom
 *    meeting is deleted — the link they hold no longer works).
 *
 * It goes through the conversation pipeline (ADR 0016): a conversation with
 * the contact is opened for it, so their reply lands in the console, and the
 * message is recorded `queued` before it is sent. It is a TRANSACTIONAL email —
 * about their own appointment, advertising nothing — so no unsubscribe; it
 * does count toward the daily limits (`email/limits.ts`).
 *
 * Every line is a template filled from the row; no model writes any of it.
 * The internal `notes` and a cancellation's reason are never in it. The time
 * is printed in the zone the appointment was booked in, with the zone's name —
 * there is no browser to ask.
 */

export const INVITATION_KIND = 'appointment_invitation';
export const CANCELLATION_KIND = 'appointment_cancellation';

/** A Zoom meeting whose link was never created: an invitation would have nothing to join. */
export const NO_LINK_PROBLEM = 'The Zoom meeting was not created yet, so there is no link to send. Press Retry on the appointment first.';

export type InvitationPreview = {
  /** Which email this is (the console words its button from it). */
  notice: ContactNotice;
  to: { email: string; name: string } | null;
  subject: string;
  body: string;
  limits: EmailLimitCheck;
  /** Which address it will come from, decided as it would be at Send (ADR 0026 §2). */
  sendFrom: string;
  /** Why it cannot be sent, if it cannot. Null when Send may be pressed. */
  problem: string | null;
};

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

type EmailFacts = Pick<AppointmentView, 'title' | 'type' | 'startsAt' | 'endsAt' | 'timezone' | 'location' | 'meetingUrl' | 'propertyAddress'> & { contactName: string };

function dayOf(a: EmailFacts): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: a.timezone, weekday: 'short', day: 'numeric', month: 'short' }).format(a.startsAt);
}

function whenOf(a: EmailFacts): string {
  const until = new Intl.DateTimeFormat('en-AU', { timeZone: a.timezone, hour: 'numeric', minute: '2-digit' }).format(a.endsAt);
  return `${formatInZone(a.startsAt, a.timezone)} – ${until}`;
}

/** The invitation, or (`update`) the same details for an appointment they were already told an older version of. */
export function buildInvitation(
  a: EmailFacts,
  from: { agentName: string; agencyName: string },
  variant: 'invitation' | 'update' = 'invitation',
): { subject: string; body: string } {
  const what = APPOINTMENT_TYPE_LABELS[a.type].toLowerCase();
  const subject = `${variant === 'update' ? 'Updated: ' : ''}${a.title} — ${dayOf(a)}`;
  const lines = [
    `Hi ${firstName(a.contactName)},`,
    '',
    variant === 'update'
      ? `Your ${what} with ${from.agentName} from ${from.agencyName} has changed. These are the up-to-date details — please use them instead of the earlier email.`
      : `This confirms your ${what} with ${from.agentName} from ${from.agencyName}.`,
    '',
    `What: ${a.title}`,
    `When: ${whenOf(a)}`,
    ...(a.propertyAddress ? [`Property: ${a.propertyAddress}`] : []),
    ...(a.location ? [`Where: ${a.location}`] : []),
    ...(a.meetingUrl ? [`Join: ${a.meetingUrl}`] : []),
    '',
    "If this time doesn't suit, just reply to this email.",
  ];
  return { subject, body: lines.join('\n') };
}

/** "Cancelled" — the time it was, and no link (the Zoom meeting is deleted). */
export function buildCancellationNotice(a: EmailFacts, from: { agentName: string; agencyName: string }): { subject: string; body: string } {
  const what = APPOINTMENT_TYPE_LABELS[a.type].toLowerCase();
  const lines = [
    `Hi ${firstName(a.contactName)},`,
    '',
    `Your ${what} with ${from.agentName} from ${from.agencyName} has been cancelled.`,
    '',
    `What: ${a.title}`,
    `Was: ${whenOf(a)}`,
    ...(a.propertyAddress ? [`Property: ${a.propertyAddress}`] : []),
    ...(a.meetingUrl ? ['The meeting link from the earlier email no longer works.'] : []),
    '',
    'If you would like a new time, just reply to this email.',
  ];
  return { subject: `Cancelled: ${a.title} — ${dayOf(a)}`, body: lines.join('\n') };
}

/** A client appointment's emails go to its contact. A team meeting has none: its people are told by notifyTeamMeeting (ADR 0038). */
async function facts(db: Db, actor: Actor, appointmentId: string) {
  const a = await getAppointment(db, actor, appointmentId);
  if (!a.contactId) throw new AppointmentError('invalid', 'A team meeting has no contact to invite — everyone on it was already told');
  const contactId = a.contactId;
  const [c] = await db
    .select({ email: contact.email, name: contact.name, agencyName: agency.name })
    .from(contact)
    .innerJoin(agency, eq(agency.id, contact.agencyId))
    .where(eq(contact.id, contactId))
    .limit(1);
  return { a: { ...a, contactId, contactName: a.contactName ?? '' }, c };
}

/** The email this appointment needs now: what its state calls for, or — when it needs none — what it would be, for the refusal. */
function noticeOf(a: AppointmentView): ContactNotice {
  return contactNoticeFor(a) ?? (a.status === 'cancelled' ? 'cancellation' : a.contactInvitedBefore ? 'update' : 'invitation');
}

function problemWith(
  a: AppointmentView,
  notice: ContactNotice,
  c: { email: string | null } | undefined,
  limits: EmailLimitCheck,
  env: NodeJS.ProcessEnv,
): string | null {
  if (!a.mayUpdate) return 'Only the agent this appointment is assigned to, or an admin, may email its contact.';
  if (a.endsAt.getTime() < Date.now()) return 'This appointment is already over.';
  if (notice === 'cancellation') {
    if (a.status !== 'cancelled') return `This appointment is ${a.status}.`;
    if (!a.contactInvitedBefore) return 'They were never emailed about this appointment, so there is nothing to cancel.';
    if (a.cancellationSent) return 'The cancellation was already emailed.';
  } else {
    if (contactNoticeFor(a) === null) {
      if (a.status !== 'scheduled' && a.status !== 'rescheduled') return `This appointment is ${a.status}.`;
      return 'An invitation for this time was already sent.';
    }
    if (a.type === 'zoom' && !a.meetingUrl) return NO_LINK_PROBLEM;
  }
  if (!c?.email) return 'This contact has no email address.';
  // Outside production, only the dev allowlist (as template email, ADR 0022).
  return devAllowlistProblem(c.email, env) ?? limits.reason;
}

function compose(a: Awaited<ReturnType<typeof facts>>['a'], notice: ContactNotice, agencyName: string | undefined) {
  const from = { agentName: a.assignedAgentName ?? 'your agent', agencyName: agencyName ?? 'the agency' };
  return notice === 'cancellation' ? buildCancellationNotice(a, from) : buildInvitation(a, from, notice);
}

export async function previewInvitation(
  db: Db,
  actor: Actor,
  appointmentId: string,
  limits: EmailLimits = emailLimitsFromEnv(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<InvitationPreview> {
  const { a, c } = await facts(db, actor, appointmentId);
  const notice = noticeOf(a);
  const check = await checkEmailLimits(db, { agencyId: a.agencyId, userId: actor.userId }, limits);
  const { subject, body } = compose(a, notice, c?.agencyName);
  return {
    notice,
    to: c?.email ? { email: c.email, name: c.name } : null,
    subject,
    body,
    limits: check,
    sendFrom: senderLine(await resolveSender(db, actor)),
    problem: problemWith(a, notice, c, check, env),
  };
}

/**
 * Send it. Every check is made again here — the preview is for the eyes, not
 * a token. The message is recorded queued in a transaction, sent after it.
 *
 * The claim, so a second click (or a second tab) sends nothing:
 *  - invitation / update: `invitation_sent_at`, set only from null. Only a
 *    delivered email keeps it and writes the timeline entry;
 *  - cancellation: its timeline entry, written under a per-appointment lock
 *    only if there is none yet (`invitation_sent_at` stays as it was — the
 *    website lists a cancelled meeting the buyer was invited to). A failed
 *    delivery removes the entry again.
 * A failed email stays in the conversation with a Retry.
 */
export async function sendInvitation(
  db: Db,
  deps: MailDeps,
  actor: Actor,
  appointmentId: string,
  limits: EmailLimits = emailLimitsFromEnv(),
): Promise<{ status: 'sent' | 'failed' | 'sending'; threadId: string; error: string | null; notice: ContactNotice }> {
  const { a, c } = await facts(db, actor, appointmentId);
  const notice = noticeOf(a);
  const check = await checkEmailLimits(db, { agencyId: a.agencyId, userId: actor.userId }, limits);
  const problem = problemWith(a, notice, c, check, deps.env ?? process.env);
  if (problem) throw new AppointmentError(check.ok ? 'conflict' : 'limit', problem);
  const to = c!.email!;
  const { subject, body } = compose(a, notice, c?.agencyName);
  const timeline = { appointmentId: a.id, title: a.title, startsAt: a.startsAt.toISOString() };

  const { threadId, messageId, cancellationEntry } = await db.transaction(async (tx) => {
    let entry: string | null = null;
    if (notice === 'cancellation') {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`appointment_cancellation:${a.id}`}))`);
      const [sent] = await tx
        .select({ id: activity.id })
        .from(activity)
        .where(and(eq(activity.contactId, a.contactId), eq(activity.kind, 'appointment_cancellation_sent'), sql`${activity.payload}->>'appointmentId' = ${a.id}`))
        .limit(1);
      if (sent) throw new AppointmentError('conflict', 'The cancellation was already emailed.');
      const [row] = await tx
        .insert(activity)
        .values({ agencyId: a.agencyId, contactId: a.contactId, kind: 'appointment_cancellation_sent', actorType: 'user', actorId: actor.userId, payload: timeline })
        .returning({ id: activity.id });
      entry = row!.id;
    } else {
      const claimed = await tx
        .update(appointment)
        .set({ invitationSentAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(appointment.id, a.id), isNull(appointment.invitationSentAt)))
        .returning({ id: appointment.id });
      if (!claimed.length) throw new AppointmentError('conflict', 'An invitation for this time was already sent.');
    }
    const [thread] = await tx
      .insert(mailThread)
      .values({
        agencyId: a.agencyId,
        contactId: a.contactId,
        subject,
        contactEmail: to,
        contactName: c!.name,
      })
      .returning({ id: mailThread.id });
    const id = await recordOutbound(tx as unknown as Db, deps, {
      threadId: thread!.id,
      agencyId: a.agencyId,
      subject,
      to,
      body,
      sentBy: actor.userId,
      channel: 'console',
      kind: notice === 'cancellation' ? CANCELLATION_KIND : INVITATION_KIND,
      // Its own new conversation: the subject as written, no "Re:".
      opening: true,
    });
    return { threadId: thread!.id, messageId: id, cancellationEntry: entry };
  });

  // The network call, after the transaction (CLAUDE.md).
  const outcome = await deliverOutbound(db, deps, messageId);
  await db.transaction(async (tx) => {
    if (notice === 'cancellation') {
      // Not delivered: they were not told — the Send comes back. The failed message has its Retry.
      if (outcome.status === 'failed' && cancellationEntry) await tx.delete(activity).where(eq(activity.id, cancellationEntry));
      return;
    }
    if (outcome.status === 'sent') {
      await recordActivity(tx, actor, a.agencyId, a.contactId, notice === 'update' ? 'appointment_update_sent' : 'appointment_invitation_sent', { ...timeline, threadId });
    } else if (outcome.status === 'failed') {
      // Not delivered: the appointment is not "invited". The failed message
      // stays in the conversation with a Retry.
      await tx.update(appointment).set({ invitationSentAt: null }).where(eq(appointment.id, a.id));
    }
    // `sending`: another delivery holds it and records the outcome (ADR 0039 Phase 1).
  });
  return { status: outcome.status, threadId, error: outcome.error, notice };
}
