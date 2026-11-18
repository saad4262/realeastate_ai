import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { checkAssistantBudget } from './budget';

/**
 * PLATFORM-PLAN 1.24: the assistant maps the budget's reasons to its messages. A reason it did not know (the
 * pool's) used to fall through to "allowed", so a trial agency over its share kept running the assistant.
 */
const actor = { userId: 'u1', agencyId: 'trial-1', membershipRole: 'agent' as const };
const env = { AI_DAILY_BUDGET_USD: '100', AI_DAILY_BUDGET_USD_TRIAL_PER_AGENCY: '2' } as unknown as NodeJS.ProcessEnv;
const db = (row: Record<string, string | null>) =>
  ({ execute: async () => [{ total: '2', person: '0', agency: '0', public_spend: '0', trial_spend: '2', pool_agency_spend: '0', pool_status: 'trial', ...row }] }) as unknown as Db;

describe('checkAssistantBudget and the pools', () => {
  it('a trial agency over its daily share is refused, with a message', async () => {
    const r = await checkAssistantBudget(db({ pool_agency_spend: '2' }), actor, { env });
    expect(r.allowed).toBe(false);
    expect(r.message).toMatch(/limit for today/);
  });

  it('under its share it runs', async () => {
    expect((await checkAssistantBudget(db({ pool_agency_spend: '1' }), actor, { env })).allowed).toBe(true);
  });
});
