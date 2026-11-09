import { and, count, eq, gte } from 'drizzle-orm';
import { aiRun, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { checkAiBudget } from '../schedules/budget';
import { HELP_FEATURE, HELP_LIMITS } from './pages';

export * from './pages';

export type HelpGate = { allowed: boolean; message: string | null };

/** May this person ask one more? Asked before the model is. The count is `ai_run`: no words are kept to count. */
export async function checkHelpAllowed(db: Db, actor: Actor, opts: { now?: Date; env?: NodeJS.ProcessEnv } = {}): Promise<HelpGate> {
  if (!actor.agencyId || !can(actor, 'help:ask', { type: 'help', agencyId: actor.agencyId })) return { allowed: false, message: 'Sign in to an agency to use help.' };
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const raw = Number(env.HELP_MESSAGES_PER_HOUR);
  const perHour = Number.isInteger(raw) && raw > 0 ? raw : HELP_LIMITS.perHour;
  const [[row], budget] = await Promise.all([
    db
      .select({ n: count() })
      .from(aiRun)
      .where(and(eq(aiRun.userId, actor.userId), eq(aiRun.feature, HELP_FEATURE), gte(aiRun.createdAt, new Date(now.getTime() - 3_600_000)))),
    checkAiBudget(db, { now, env }),
  ]);
  if ((row?.n ?? 0) >= perHour) return { allowed: false, message: 'That is a lot of questions for one hour. Try again a little later.' };
  if (!budget.allowed) return { allowed: false, message: 'Help is resting until tomorrow. The sidebar still has everything.' };
  return { allowed: true, message: null };
}
