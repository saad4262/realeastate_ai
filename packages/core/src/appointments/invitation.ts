import { and, eq, isNull, sql } from 'drizzle-orm';
import { agency, appointment, contact, mailThread, type Db } from '@repo/db';
import type { Actor } from '../permissions';
import { checkEmailLimits, devAllowlistProblem, emailLimitsFromEnv, type EmailLimitCheck, type EmailLimits } from '../email/limits';
import { deliverOutbound, recordOutbound, type MailDeps } from '../mail/send';
import { recordActivity } from '../contacts/write-contacts';
import { formatInZone } from '../time/local-input';
import { ACTIVE_STATUSES, APPOINTMENT_TYPE_LABELS } from './appointment-schema';
import { AppointmentError, getAppointment, type AppointmentView } from './appointments';

/**
 * The invitation email to the contact (ADR 0019) — never automatic. The
 * agent ticks "Send invitation", sees exactly what will be sent
 * (`previewInvitation`), and presses Send (`sendInvitation`).
 *
 * It goes through the conversation pipeline (ADR 0016): a conversation with
 * the contact is opened for it, so their reply lands in the console, and the
 * message is recorded `queued` before it is sent. It is a TRANSACTIONAL email —
 * about their own appointment, advertising nothing — so no unsubscribe; it
 * does count toward the daily limits (`email/limits.ts`).
 *
 * Every line is a template filled from the row; no model writes any of it.
 * The internal `notes` are never in it. The time is printed in the zone the
 * appointment was booked in, with the zone's name — there is no browser to ask.
 */

export const INVITATION_KIND = 'appointment_invitation';

export type InvitationPreview = {
  to: { email: string; name: string } | null;
  subject: string;
  body: string;
  limits: EmailLimitCheck;
  /** Why it cannot be sent, if it cannot. Null when Send may be pressed. */
  problem: string | null;
};

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export function buildInvitation(
  a: Pick<AppointmentView, 'title' | 'type' | 'startsAt' | 'endsAt' | 'timezone' | 'location' | 'meetingUrl' | 'propertyAddress' | 'contactName'>,
  from: { agentName: string; agencyName: string },
): { subject: string; body: string } {
  const when = formatInZone(a.startsAt, a.timezone);
  const until = new Intl.DateTimeFormat('en-AU', { timeZone: a.timezone, hour: 'numeric', minute: '2-digit' }).format(a.endsAt);
  const what = APPOINTMENT_TYPE_LABELS[a.type].toLowerCase();
  const subject = `${a.title} — ${new Intl.DateTimeFormat('en-AU', { timeZone: a.timezone, weekday: 'short', day: 'numeric', month: 'short' }).format(a.startsAt)}`;
  const lines = [
    `Hi ${firstName(a.contactName)},`,
    '',
    `This confirms your ${what} with ${from.agentName} from ${from.agencyName}.`,
    '',
    `What: ${a.title}`,
    `When: ${when} – ${until}`,
    ...(a.propertyAddress ? [`Property: ${a.propertyAddress}`] : []),
    ...(a.location ? [`Where: ${a.location}`] : []),
    ...(a.meetingUrl ? [`Join: ${a.meetingUrl}`] : []),
    '',
    "If this time doesn't suit, just reply to this email.",
  ];
  return { subject, body: lines.join('\n') };
}

async function facts(db: Db, actor: Actor, appointmentId: string) {
  const a = await getAppointment(db, actor, appointmentId);
  const [c] = await db
    .select({ email: contact.email, name: contact.name, agencyName: agency.name })
    .from(contact)
    .innerJoin(agency, eq(agency.id, contact.agencyId))
    .where(eq(contact.id, a.contactId))
    .limit(1);
  return { a, c };
}

function problemWith(
  a: AppointmentView,
  c: { email: string | null } | undefined,
  limits: EmailLimitCheck,
  env: NodeJS.ProcessEnv,
): string | null {
  if (!a.mayUpdate) return 'Only the agent this appointment is assigned to, or an admin, may send its invitation.';
  if (!ACTIVE_STATUSES.includes(a.status)) return `This appointment is ${a.status}.`;
  if (a.endsAt.getTime() < Date.now()) return 'This appointment is already over.';
  if (a.invitationSentAt) return 'An invitation for this time was already sent.';
  if (!c?.email) return 'This contact has no email address.';
  // Outside production, only the dev allowlist (as template email, ADR 0022).
  return devAllowlistProblem(c.email, env) ?? limits.reason;
}

export async function previewInvitation(
  db: Db,
  actor: Actor,
  appointmentId: string,
  limits: EmailLimits = emailLimitsFromEnv(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<InvitationPreview> {
  const { a, c } = await facts(db, actor, appointmentId);
  const check = await checkEmailLimits(db, { agencyId: a.agencyId, userId: actor.userId }, limits);
  const { subject, body } = buildInvitation(a, {
    agentName: a.assignedAgentName ?? 'your agent',
    agencyName: c?.agencyName ?? 'the agency',
  });
  return {
    to: c?.email ? { email: c.email, name: c.name } : null,
    subject,
    body,
    limits: check,
    problem: problemWith(a, c, check, env),
  };
}

/**
 * Send it. Every check is made again here — the preview is for the eyes, not
 * a token. The message is recorded queued in a transaction, sent after it,
 * and only a delivered email marks the appointment invited and writes the
 * timeline entry. A failed one stays in the conversation with a Retry.
 */
export async function sendInvitation(
  db: Db,
  deps: MailDeps,
  actor: Actor,
  appointmentId: string,
  limits: EmailLimits = emailLimitsFromEnv(),
): Promise<{ status: 'sent' | 'failed'; threadId: string; error: string | null }> {
  const { a, c } = await facts(db, actor, appointmentId);
  const check = await checkEmailLimits(db, { agencyId: a.agencyId, userId: actor.userId }, limits);
  const problem = problemWith(a, c, check, deps.env ?? process.env);
  if (problem) throw new AppointmentError(check.ok ? 'conflict' : 'limit', problem);
  const to = c!.email!;
  const { subject, body } = buildInvitation(a, {
    agentName: a.assignedAgentName ?? 'your agent',
    agencyName: c?.agencyName ?? 'the agency',
  });

  const { threadId, messageId } = await db.transaction(async (tx) => {
    // Claim the send: a second click (or a second tab) finds it claimed.
    const claimed = await tx
      .update(appointment)
      .set({ invitationSentAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(appointment.id, a.id), isNull(appointment.invitationSentAt)))
      .returning({ id: appointment.id });
    if (!claimed.length) throw new AppointmentError('conflict', 'An invitation for this time was already sent.');
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
      kind: INVITATION_KIND,
    });
    return { threadId: thread!.id, messageId: id };
  });

  // The network call, after the transaction (CLAUDE.md).
  const outcome = await deliverOutbound(db, deps, messageId);
  await db.transaction(async (tx) => {
    if (outcome.status === 'sent') {
      await recordActivity(tx, actor, a.agencyId, a.contactId, 'appointment_invitation_sent', {
        appointmentId: a.id,
        title: a.title,
        startsAt: a.startsAt.toISOString(),
        threadId,
      });
    } else {
      // Not delivered: the appointment is not "invited". The failed message
      // stays in the conversation with a Retry.
      await tx.update(appointment).set({ invitationSentAt: null }).where(eq(appointment.id, a.id));
    }
  });
  return { status: outcome.status, threadId, error: outcome.error };
}
