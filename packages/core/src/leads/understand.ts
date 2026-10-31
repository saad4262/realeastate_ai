import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';
import { decisionText, workflowAiAllowed } from '../workflows/decide';
import { rawUnderstandingSchema, verifyUnderstanding, type RawUnderstanding, type Understanding } from './understand-facts';

/**
 * "AI understands" (ADR 0078): a minute-tick job reads each new enquiry, inspection or appraisal request — never
 * a private offer — while its agency's skill "AI understands enquiries" is on, asks the model what kind of person
 * it is, how urgent, a summary and the brief in their own words, keeps only what the enquiry really says
 * (`verifyUnderstanding`) and writes it on the lead. The model is behind `LeadUnderstander`, implemented in
 * packages/ai (#3). Nothing here changes a contact: the brief reaches one only through an approval card.
 */

export const LEAD_UNDERSTAND_FEATURE = 'lead:understand';
export const LEAD_UNDERSTAND_SKILL = 'ai_understand_enquiries';
/** Kinds it reads. Never `offer` (owners' and admins' only) or `agency`. */
export const UNDERSTOOD_KINDS = ['enquiry', 'inspection', 'appraisal'] as const;
/** Only leads this new are picked up: switching the skill on never reads the backlog. */
const WINDOW_HOURS = 24;
/** A claim older than this was a job that died: taken again. */
const CLAIM_MINUTES = 5;

export type LeadUnderstander = (input: { text: string; agencyId: string; userId: string | null }) => Promise<RawUnderstanding>;

export type LeadAiStatus = 'done' | 'not_sure' | 'off' | 'budget' | 'no_text' | 'failed';
export type UnderstandReport = { off: number; claimed: number; done: number; skipped: number; failed: number };

const kinds = sql.raw(`(${UNDERSTOOD_KINDS.map((k) => `'${k}'`).join(', ')})`);
const skillOn = (agency: ReturnType<typeof sql>) =>
  sql`exists (select 1 from skill_switch s where s.agency_id = ${agency} and s.user_id is null and s.skill_key = ${LEAD_UNDERSTAND_SKILL} and s.enabled)`;

/** Where the understanding is kept on the lead (`ai_qualification`). */
export type StoredUnderstanding = { intentWhy: string | null; urgencyWhy: string | null; facts: Understanding['facts']; dropped: Understanding['dropped'] };

export async function runLeadUnderstanding(
  db: Db,
  understander: LeadUnderstander | null,
  now = new Date(),
  limit = 10,
  opts: { env?: NodeJS.ProcessEnv; agencyId?: string } = {},
): Promise<UnderstandReport> {
  const report: UnderstandReport = { off: 0, claimed: 0, done: 0, skipped: 0, failed: 0 };
  const since = new Date(now.getTime() - WINDOW_HOURS * 3_600_000).toISOString();
  const nowIso = now.toISOString();
  const scope = opts.agencyId ? sql`and l.agency_id = ${opts.agencyId}::uuid` : sql``;

  // The skill off (or no AI on this server): said once, so screens and workflows stop waiting.
  const off = await db.execute<{ id: string }>(sql`
    update lead l set ai_status = 'off', ai_understood_at = ${nowIso}::timestamptz
    where l.ai_status is null and l.kind::text in ${kinds} and l.created_at > ${since}::timestamptz ${scope}
      and (${understander === null}::boolean or not ${skillOn(sql`l.agency_id`)})
    returning l.id`);
  report.off = off.length;
  if (!understander) return report;

  // Claim a batch (ai_understood_at doubles as the claim's time; ai_status stays null until it is decided).
  const claimed = await db.execute<{ id: string; agency_id: string; assigned_to: string | null }>(sql`
    update lead l set ai_understood_at = ${nowIso}::timestamptz
    where l.id in (
      select x.id from lead x
      where x.ai_status is null and x.kind::text in ${kinds} and x.created_at > ${since}::timestamptz
        and (x.ai_understood_at is null or x.ai_understood_at < ${nowIso}::timestamptz - make_interval(mins => ${CLAIM_MINUTES}))
        and x.agency_id not in ${SUSPENDED_AGENCY_IDS} ${opts.agencyId ? sql`and x.agency_id = ${opts.agencyId}::uuid` : sql``}
        and ${skillOn(sql`x.agency_id`)}
      order by x.created_at
      limit ${limit}
      for update skip locked)
    returning l.id, l.agency_id, l.assigned_to`);
  report.claimed = claimed.length;

  for (const l of claimed) {
    const status = await understandOne(db, understander, { id: l.id, agencyId: l.agency_id, assignedTo: l.assigned_to }, now, opts.env ?? process.env);
    if (status === 'done' || status === 'not_sure') report.done++;
    else if (status === 'failed') report.failed++;
    else report.skipped++;
  }
  return report;
}

async function understandOne(db: Db, understander: LeadUnderstander, l: { id: string; agencyId: string; assignedTo: string | null }, now: Date, env: NodeJS.ProcessEnv): Promise<LeadAiStatus> {
  const mark = async (status: LeadAiStatus, u?: Understanding) => {
    const stored: StoredUnderstanding | null = u ? { intentWhy: u.intentWhy, urgencyWhy: u.urgencyWhy, facts: u.facts, dropped: u.dropped } : null;
    await db.execute(sql`
      update lead set ai_status = ${status}, ai_understood_at = ${now.toISOString()}::timestamptz,
        ai_intent = ${u?.intent ?? null}, ai_urgency = ${u?.urgency ?? null}, ai_summary = ${u?.summary ?? null},
        ai_qualification = ${stored ? JSON.stringify(stored) : null}::jsonb
      where id = ${l.id} and agency_id = ${l.agencyId}`);
    return status;
  };
  const text = await decisionText(db, { agencyId: l.agencyId, leadId: l.id, appointmentId: null });
  if (!text) return mark('no_text');
  if (!(await workflowAiAllowed(db, l.agencyId, env, now))) return mark('budget');
  let raw: RawUnderstanding;
  try {
    raw = rawUnderstandingSchema.parse(await understander({ text, agencyId: l.agencyId, userId: l.assignedTo }));
  } catch (err) {
    console.error('[leads] understanding failed', l.id, err instanceof Error ? err.message : err);
    return mark('failed');
  }
  const u = verifyUnderstanding(raw, text);
  return mark(u.intent === 'not_sure' ? 'not_sure' : 'done', u);
}
