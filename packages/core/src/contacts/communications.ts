import { sql, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { displayAu } from '../phone/format';
import { loadContactHead, type ReadableContact } from './get-contact';
import { CONTACT_NOT_FOUND, ContactError } from './list-contacts';
import { logCallSchema, type LogCallInput } from './contact-schema';
import { contactResource } from './visibility';
import { recordActivity } from './write-contacts';

/**
 * A profile's SMS and Calls tabs (ADR 0083), each its own read and never mixed with email. Texts and calls keep the
 * rule of their own screens (ADR 0070): an agent sees what is on their own number, an owner or admin every number's.
 * A row belongs to the contact it names, or, when it names nobody, to the contact whose phone key it shares.
 */

/** `pn` is phone_number. */
export function numberScopeSql(actor: Actor, agencyId: string): SQL {
  return can(actor, 'sms:read', { type: 'sms', agencyId }) ? sql`true` : sql`pn.user_id = ${actor.userId}`;
}

/** The row is this contact's. `contactColumn` and `phoneColumn` are trusted column names, never input. */
export function belongsToContactSql(contactColumn: string, phoneColumn: string, contactId: string): SQL {
  const named = sql.raw(contactColumn);
  return sql`(${named} = ${contactId} or (${named} is null and public.au_phone_key(${sql.raw(phoneColumn)}) = (select c.phone_key from contact c where c.id = ${contactId})))`;
}

export type ContactText = { id: string; direction: 'in' | 'out'; body: string; status: string; error: string | null; kind: string | null; byName: string | null; at: Date };
export type ContactTextConversation = {
  phoneNumberId: string;
  counterpart: string;
  display: string;
  numberDisplay: string;
  agentName: string;
  optedOut: boolean;
  /** Oldest first. */
  messages: ContactText[];
};
export type ContactTexts = { total: number; received: number; sent: number; failed: number; conversations: ContactTextConversation[] };

export const CONTACT_TEXTS_LIMIT = 300;

/** Their texts, by conversation, the newest conversation first. One statement. */
export async function listContactTexts(db: Db, actor: Actor, c: ReadableContact): Promise<ContactTexts> {
  const rows = await db.execute<{
    id: string; phone_number_id: string; counterpart: string; e164: string; direction: 'in' | 'out'; body: string; status: string; error: string | null;
    kind: string | null; created_at: Date | string; agent_name: string; by_name: string | null; opted_out: boolean; total: string; received: string; sent: string; failed: string;
  }>(sql`
    select m.id, m.phone_number_id, m.counterpart, pn.e164, m.direction, m.body, m.status, m.error, m.kind, m.created_at,
      coalesce(u.name, u.email) as agent_name,
      (select coalesce(s.name, s.email) from "user" s where s.id = m.sent_by) as by_name,
      exists (select 1 from sms_opt_out o where o.agency_id = m.agency_id and o.e164 = m.counterpart) as opted_out,
      count(*) over() as total,
      count(*) filter (where m.direction = 'in') over() as received,
      count(*) filter (where m.direction = 'out') over() as sent,
      count(*) filter (where m.status in ('failed', 'undelivered')) over() as failed
    from sms_message m
    join phone_number pn on pn.id = m.phone_number_id
    join "user" u on u.id = pn.user_id
    where m.agency_id = ${c.agencyId} and ${belongsToContactSql('m.contact_id', 'm.counterpart', c.id)} and ${numberScopeSql(actor, c.agencyId)}
    order by m.created_at desc
    limit ${CONTACT_TEXTS_LIMIT}`);

  const conversations = new Map<string, ContactTextConversation>();
  for (const r of rows) {
    const key = `${r.phone_number_id}|${r.counterpart}`;
    let conv = conversations.get(key);
    if (!conv) {
      conv = { phoneNumberId: r.phone_number_id, counterpart: r.counterpart, display: displayAu(r.counterpart), numberDisplay: displayAu(r.e164), agentName: r.agent_name, optedOut: Boolean(r.opted_out), messages: [] };
      conversations.set(key, conv);
    }
    conv.messages.unshift({ id: r.id, direction: r.direction, body: r.body, status: r.status, error: r.error, kind: r.kind, byName: r.by_name, at: new Date(r.created_at) });
  }
  const first = rows[0];
  return { total: Number(first?.total ?? 0), received: Number(first?.received ?? 0), sent: Number(first?.sent ?? 0), failed: Number(first?.failed ?? 0), conversations: [...conversations.values()] };
}

export type ContactCall =
  | {
      source: 'phone';
      id: string;
      at: Date;
      from: string | null;
      /** Whose number it rang. */
      who: string;
      outcome: string | null;
      handled: boolean;
      /** The AI call back (ADR 0072). `aiSummary` is the model's: shown labelled (#7). */
      aiStatus: string | null;
      aiSummary: string | null;
      aiDurationS: number | null;
    }
  | { source: 'logged'; id: string; at: Date; who: string | null; direction: 'in' | 'out'; outcome: LogCallInput['outcome']; minutes: number | null; note: string | null };

export type ContactCalls = { total: number; missed: number; aiCallBacks: number; logged: number; lastAt: Date | null; rows: ContactCall[] };

export const CONTACT_CALLS_LIMIT = 200;

/** Missed calls and AI call backs from the platform, and the calls people logged, newest first. One statement. */
export async function listContactCalls(db: Db, actor: Actor, c: ReadableContact): Promise<ContactCalls> {
  const rows = await db.execute<{
    source: 'phone' | 'logged'; id: string; at: Date | string; from_e164: string | null; who: string | null; outcome: string | null; handled_at: Date | string | null;
    ai_status: string | null; ai_summary: string | null; ai_duration_s: number | null; payload: Record<string, unknown> | null; total: string; missed: string; ai: string; logged: string;
  }>(sql`
    select t.*,
      count(*) over() as total,
      count(*) filter (where t.source = 'phone') over() as missed,
      count(*) filter (where t.ai_status = 'done') over() as ai,
      count(*) filter (where t.source = 'logged') over() as logged
    from (
      select 'phone' as source, pc.id, pc.created_at as at, pc.from_e164, coalesce(u.name, u.email) as who, pc.outcome::text as outcome, pc.handled_at,
        pc.ai_status::text as ai_status, pc.ai_summary, pc.ai_duration_s, null::jsonb as payload
      from phone_call pc
      join phone_number pn on pn.id = pc.phone_number_id
      join "user" u on u.id = pn.user_id
      where pc.agency_id = ${c.agencyId} and pc.kind = 'missed' and ${belongsToContactSql('pc.contact_id', 'pc.from_e164', c.id)} and ${numberScopeSql(actor, c.agencyId)}
      union all
      select 'logged', a.id, a.occurred_at, null, coalesce(u.name, u.email), null, null, null, null, null, a.payload
      from activity a
      left join "user" u on u.id = a.actor_id
      where a.contact_id = ${c.id} and a.agency_id = ${c.agencyId} and a.kind = 'call_logged'
    ) t
    order by t.at desc
    limit ${CONTACT_CALLS_LIMIT}`);

  const list = rows.map((r): ContactCall => {
    const at = new Date(r.at);
    if (r.source === 'logged') {
      const p = r.payload ?? {};
      return {
        source: 'logged',
        id: r.id,
        at,
        who: r.who,
        direction: p.direction === 'in' ? 'in' : 'out',
        outcome: p.outcome === 'no_answer' || p.outcome === 'voicemail' ? p.outcome : 'answered',
        minutes: typeof p.minutes === 'number' ? p.minutes : null,
        note: typeof p.note === 'string' && p.note ? p.note : null,
      };
    }
    return { source: 'phone', id: r.id, at, from: r.from_e164 ? displayAu(r.from_e164) : null, who: r.who ?? 'Their number', outcome: r.outcome, handled: Boolean(r.handled_at), aiStatus: r.ai_status, aiSummary: r.ai_summary, aiDurationS: r.ai_duration_s };
  });
  const first = rows[0];
  return { total: Number(first?.total ?? 0), missed: Number(first?.missed ?? 0), aiCallBacks: Number(first?.ai ?? 0), logged: Number(first?.logged ?? 0), lastAt: list[0]?.at ?? null, rows: list };
}

/** A call the platform could not see (ADR 0083 §4): `note:create`'s people. One row in `activity`. */
export async function logContactCall(db: DbOrTx, actor: Actor, contactId: string, raw: unknown): Promise<void> {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw CONTACT_NOT_FOUND();
  const resource = contactResource(head.facts);
  if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
  if (!can(actor, 'contact_call:log', resource)) throw new ContactError('forbidden', 'You can read this contact but not log calls');
  const parsed = logCallSchema.safeParse(raw);
  if (!parsed.success) throw new ContactError('invalid', parsed.error.issues[0]?.message ?? 'Check the call details');
  const { direction, outcome, minutes, note } = parsed.data;
  await recordActivity(db, actor, head.row.agencyId, head.row.id, 'call_logged', { direction, outcome, minutes: minutes ?? null, note: note || null });
}
