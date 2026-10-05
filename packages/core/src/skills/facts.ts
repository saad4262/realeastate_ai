import { and, asc, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { contact, type Db } from '@repo/db';
import type { Actor } from '../permissions';
import { listAppointments } from '../appointments/appointments';
import { APPOINTMENT_TYPE_LABELS } from '../appointments/appointment-schema';
import { listAgencyLeads } from '../leads/list-leads';
import { listMailThreads } from '../mail/threads';
import { localPartsIn } from '../schedules/next-run';
import type { CitableRecord } from './citations';

/**
 * What a skill reads, gathered AS THE AGENT through the same scoped reads
 * the screens use (docs/adr/0021 §4) — so a brief can only mention what that
 * agent could open. Each record gets a label (`[A1]`) the model must cite,
 * and the text it is allowed to quote. Times, counts and links stay in the
 * structured result, rendered from SQL; the model text never carries them.
 */

export type RecordLink =
  | { type: 'appointment'; id: string; contactId: string }
  | { type: 'contact'; id: string }
  | { type: 'thread'; id: string }
  | { type: 'lead'; id: string; threadId: string | null };

export type SkillItem = CitableRecord & {
  kind: 'appointment' | 'next_action' | 'email' | 'lead';
  /** What the result page shows — from SQL. */
  title: string;
  detail: string | null;
  /** ISO instant, when the item has one (appointment start, email time, due). */
  at: string | null;
  link: RecordLink;
  /** On an email: is it a private offer's conversation. */
  offer?: boolean;
};

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function sameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const x = localPartsIn(a, timeZone);
  const y = localPartsIn(b, timeZone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** Conversations waiting on this agent: the newest message is theirs (inbound), the lead not closed. */
async function waitingThreads(db: Db, actor: Actor, limit: number) {
  const page = await listMailThreads(db, actor, { limit: 100 });
  return page.rows.filter((r) => !r.lastFromUs && r.leadStatus !== 'closed').slice(0, limit);
}

export type MorningBriefFacts = {
  appointments: SkillItem[];
  nextActions: SkillItem[];
  emails: SkillItem[];
  leads: SkillItem[];
};

export async function gatherMorningBrief(db: Db, actor: Actor, timeZone: string, now: Date): Promise<MorningBriefFacts> {
  const [appts, overdue, threads, leads] = await Promise.all([
    listAppointments(db, actor, { when: 'upcoming', limit: 50, now }),
    db
      .select({ id: contact.id, name: contact.name, nextAction: contact.nextAction, nextActionAt: contact.nextActionAt })
      .from(contact)
      .where(
        and(
          eq(contact.agencyId, actor.agencyId as string),
          eq(contact.assignedTo, actor.userId),
          isNotNull(contact.nextAction),
          lt(contact.nextActionAt, now),
          isNull(contact.archivedAt),
          isNull(contact.mergedIntoId),
        ),
      )
      .orderBy(asc(contact.nextActionAt))
      .limit(10),
    waitingThreads(db, actor, 10),
    listAgencyLeads(db, actor, { limit: 50 }),
  ]);

  const today = appts.rows.filter((a) => sameLocalDay(a.startsAt, now, timeZone)).slice(0, 15);
  const fresh = leads.rows
    .filter((l) => l.status === 'new' && now.getTime() - l.createdAt.getTime() < 24 * 3600_000)
    .slice(0, 10);

  return {
    appointments: today.map((a, i) => ({
      ref: `A${i + 1}`,
      kind: 'appointment',
      text: `${APPOINTMENT_TYPE_LABELS[a.type]} with ${a.contactName}: ${a.title}`,
      title: a.title,
      detail: `${APPOINTMENT_TYPE_LABELS[a.type]} with ${a.contactName}${a.location ? ` · ${a.location}` : ''}`,
      at: a.startsAt.toISOString(),
      link: { type: 'appointment', id: a.id, contactId: a.contactId },
    })),
    nextActions: overdue.map((c, i) => ({
      ref: `C${i + 1}`,
      kind: 'next_action',
      text: `Overdue next action for ${c.name}: ${clip(c.nextAction, 200)}`,
      title: c.name,
      detail: clip(c.nextAction, 200),
      at: c.nextActionAt ? new Date(c.nextActionAt).toISOString() : null,
      link: { type: 'contact', id: c.id },
    })),
    emails: threads.map((t, i) => ({
      ref: `E${i + 1}`,
      kind: 'email',
      text: `${t.contactName || t.contactEmail} is waiting for a reply: ${clip(t.subject, 120)} — ${clip(t.preview, 200)}`,
      title: t.contactName || t.contactEmail,
      detail: clip(t.subject, 120),
      at: t.lastMessageAt.toISOString(),
      link: { type: 'thread', id: t.id },
      offer: t.leadKind === 'offer',
    })),
    leads: fresh.map((l, i) => ({
      ref: `L${i + 1}`,
      kind: 'lead',
      text: `New ${l.kind} from ${l.name} about ${l.address}`,
      title: l.name,
      detail: `${l.kind === 'offer' ? 'Private offer' : 'Enquiry'} · ${l.address}`,
      at: l.createdAt.toISOString(),
      link: { type: 'lead', id: l.id, threadId: l.threadId },
    })),
  };
}

export function briefRecords(f: MorningBriefFacts): SkillItem[] {
  return [...f.appointments, ...f.nextActions, ...f.emails, ...f.leads];
}

/** Template sentence when the model is not used or its text was rejected. Counts from SQL. */
export function briefTemplate(f: MorningBriefFacts): string {
  const parts = [
    f.appointments.length ? `${f.appointments.length} appointment${f.appointments.length === 1 ? '' : 's'} today` : null,
    f.nextActions.length ? `${f.nextActions.length} overdue next action${f.nextActions.length === 1 ? '' : 's'}` : null,
    f.emails.length ? `${f.emails.length} conversation${f.emails.length === 1 ? '' : 's'} waiting for you` : null,
    f.leads.length ? `${f.leads.length} new lead${f.leads.length === 1 ? '' : 's'} since yesterday` : null,
  ].filter(Boolean);
  return parts.length ? `Today: ${parts.join(', ')}.` : 'Your day is clear — nothing booked, overdue or waiting.';
}

/** The open conversations to rank: up to 30, newest first, as the agent sees them. */
export async function gatherImportantEmails(db: Db, actor: Actor): Promise<SkillItem[]> {
  const threads = await waitingThreads(db, actor, 30);
  return threads.map((t, i) => ({
    ref: `T${i + 1}`,
    kind: 'email',
    text: `${t.leadKind === 'offer' ? 'PRIVATE OFFER. ' : t.leadKind ? `${t.leadKind}. ` : 'Email to the agency. '}${t.leadStatus === 'new' ? 'Not yet handled. ' : ''}From ${t.contactName || t.contactEmail}: ${clip(t.subject, 120)} — ${clip(t.preview, 300)}`,
    title: t.contactName || t.contactEmail,
    detail: clip(t.subject, 120),
    at: t.lastMessageAt.toISOString(),
    link: { type: 'thread', id: t.id },
    offer: t.leadKind === 'offer',
  }));
}

/** The fallback ranking: offers first, then whoever has waited longest. From SQL alone. */
export function templateRanking(items: SkillItem[], max = 10): { ref: string; reason: string | null }[] {
  return [...items]
    .sort((a, b) => Number(Boolean(b.offer)) - Number(Boolean(a.offer)) || (a.at ?? '').localeCompare(b.at ?? ''))
    .slice(0, max)
    .map((i) => ({ ref: i.ref, reason: null }));
}
