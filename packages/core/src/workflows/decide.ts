import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { isSkillOn } from '../skill-switches/switches';
import { stripQuotedReply } from '../mail/body';
import { NOT_SURE, type Decide, type WorkflowAction, type WorkflowSpec } from './catalog';

/**
 * "AI decides" (ADR 0067, ROADMAP 4.2): at the start of a run, the AI reads the trigger's record and picks
 * ONE of the workflow's own labels; that choice's steps run, and when it is not sure — or is not asked — the
 * workflow's own steps ("Not sure") run. The model is behind `WorkflowDecider`, implemented in packages/ai
 * (#3). Core decides what it may read, checks the answer is one of the labels, and records the choice and why
 * on the run. The AI never writes a step, sends anything, or invents an option.
 */

export const WORKFLOW_DECIDE_FEATURE = 'workflow:decide';
const TEXT_CHARS = 3000;
const REASON_CHARS = 200;

export type WorkflowDecider = (input: { question: string; choices: string[]; text: string; agencyId: string; userId: string }) => Promise<{ choice: string | null; reason: string }>;
export type RunDecision = { choice: string | null; reason: string; by: 'ai' | 'off' | 'budget' | 'no_text' | 'failed' | 'unavailable' };

/** One of the labels, matched without case or spacing, or null — anything else the model says is "Not sure". Pure. */
export function pickChoice(raw: string | null | undefined, labels: readonly string[]): string | null {
  if (!raw) return null;
  const n = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return labels.find((l) => n(l) === n(raw)) ?? null;
}

/** What the AI reads (the user's decision 2): the enquiry and the newest email from the client; or an appointment's outcome. */
export async function decisionText(db: Db, f: { agencyId: string; leadId: string | null; appointmentId: string | null }): Promise<string | null> {
  if (f.leadId) {
    const [r] = await db.execute<{ message: string | null; mail: string | null; subject: string | null }>(sql`
      select l.message,
        (select m.text from mail_thread t join mail_message m on m.thread_id = t.id
          where t.lead_id = l.id and m.direction = 'in' order by m.created_at desc limit 1) as mail,
        (select m.subject from mail_thread t join mail_message m on m.thread_id = t.id
          where t.lead_id = l.id and m.direction = 'in' order by m.created_at desc limit 1) as subject
      from lead l where l.id = ${f.leadId} and l.agency_id = ${f.agencyId}`);
    const parts = [r?.message?.trim() ? `Enquiry: ${r.message.trim()}` : null, r?.mail ? `Latest email${r.subject ? ` (“${r.subject}”)` : ''}: ${stripQuotedReply(r.mail).trim()}` : null].filter(Boolean);
    const text = parts.join('\n\n').slice(0, TEXT_CHARS);
    return text.trim() ? text : null;
  }
  if (f.appointmentId) {
    const [r] = await db.execute<{ outcome: string | null; title: string }>(sql`select outcome, title from appointment where id = ${f.appointmentId} and agency_id = ${f.agencyId}`);
    return r?.outcome?.trim() ? `Appointment “${r.title}” — outcome: ${r.outcome.trim()}`.slice(0, TEXT_CHARS) : null;
  }
  return null;
}

function capFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Today's spend on workflow decisions for this agency, and on AI overall, under their caps. */
export async function workflowAiAllowed(db: Db, agencyId: string, env: NodeJS.ProcessEnv, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const [row] = await db.execute<{ agency: string; total: string }>(sql`
    select
      coalesce((select sum(r.cost_usd) from ai_run r where r.agency_id = ${agencyId} and r.feature = ${WORKFLOW_DECIDE_FEATURE} and r.created_at >= ${since}), 0) as agency,
      coalesce((select sum(r.cost_usd) from ai_run r where r.created_at >= ${since}), 0) as total`);
  return Number(row?.total ?? 0) < capFrom(env.AI_DAILY_BUDGET_USD, 5) && Number(row?.agency ?? 0) < capFrom(env.WORKFLOW_AI_DAILY_BUDGET_USD_PER_AGENCY, 2);
}

/** The chosen label's steps, or the workflow's own ("Not sure"). Pure. */
export function stepsOfChoice(spec: WorkflowSpec, choice: string | null): WorkflowAction[] {
  return spec.decide?.choices.find((c) => c.label === choice)?.actions ?? spec.actions;
}

/**
 * Ask, under the owner's "AI decisions in workflows" switch and the budget, and never fail the run: anything
 * that goes wrong is "Not sure", with why.
 */
export async function decideRun(
  db: Db,
  owner: Actor,
  decide: Decide,
  f: { agencyId: string; leadId: string | null; appointmentId: string | null },
  decider: WorkflowDecider | null,
  opts: { env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<RunDecision> {
  if (!decider) return { choice: null, reason: 'The AI is not set up on this server, so “Not sure” ran.', by: 'unavailable' };
  if (!(await isSkillOn(db, owner, 'ai_workflow_decisions'))) return { choice: null, reason: 'AI decisions are switched off in Skills, so “Not sure” ran.', by: 'off' };
  const text = await decisionText(db, f);
  if (!text) return { choice: null, reason: 'There was nothing written to read, so “Not sure” ran.', by: 'no_text' };
  if (!(await workflowAiAllowed(db, f.agencyId, opts.env ?? process.env, opts.now ?? new Date()))) {
    return { choice: null, reason: 'Today’s AI budget for workflow decisions is used up, so “Not sure” ran.', by: 'budget' };
  }
  const labels = decide.choices.map((c) => c.label);
  try {
    const raw = await decider({ question: decide.question, choices: labels, text, agencyId: f.agencyId, userId: owner.userId });
    const choice = pickChoice(raw.choice, labels);
    const reason = raw.reason.replace(/\s+/g, ' ').trim().slice(0, REASON_CHARS) || (choice ? '' : `The AI was not sure.`);
    return { choice, reason, by: 'ai' };
  } catch (err) {
    console.error('[workflow] decision failed', err instanceof Error ? err.message : err);
    return { choice: null, reason: 'The AI could not be asked just then, so “Not sure” ran.', by: 'failed' };
  }
}

export { NOT_SURE };
