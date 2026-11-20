// PLATFORM-PLAN 3.7: a paused agency shows a banner on every page of both surfaces; only an owner or admin gets Resume, and pressing it
// lifts the pause and writes the audit row.
import { expect, test } from '@playwright/test';
import { sqlClient, world } from '../fixture';
import { urls } from '../playwright.config';
import { signIn } from './helpers';

const SHOTS = process.env.E2E_SHOTS;

test('sends paused: everyone sees why; an agent cannot resume; the owner resumes and it is audited', async ({ browser }) => {
  const w = world();
  const sql = sqlClient();
  try {
    await sql`update agency set sends_paused_at = now(), sends_paused_reason = 'Far above this agency''s usual: texts 120 this hour.' where id = ${w.a.agencyId}`;

    const agent = await browser.newPage();
    await signIn(agent, urls.agent, w.a.agent.email);
    const agentBanner = agent.getByRole('alert').filter({ hasText: 'Sends are paused.' });
    await expect(agentBanner).toContainText('texts 120 this hour');
    await expect(agentBanner).toContainText('until an owner or admin resumes them');
    await expect(agentBanner.getByRole('button', { name: 'Resume sends' })).toHaveCount(0);
    if (SHOTS) await agent.screenshot({ path: `${SHOTS}/sends-paused-agent.png` });
    await agent.close();

    const owner = await browser.newPage();
    await signIn(owner, urls.agency, w.a.owner.email);
    const banner = owner.getByRole('alert').filter({ hasText: 'Sends are paused.' });
    await expect(banner).toBeVisible();
    if (SHOTS) await owner.screenshot({ path: `${SHOTS}/sends-paused-owner.png` });
    await banner.getByRole('button', { name: 'Resume sends' }).click();
    await expect(banner).toHaveCount(0);

    const [a] = await sql`select sends_paused_at from agency where id = ${w.a.agencyId}`;
    expect(a!.sends_paused_at).toBeNull();
    const audit = await sql`select actor_user_id from audit_log where agency_id = ${w.a.agencyId} and action = 'sends_resumed'`;
    expect(audit.map((r) => r.actor_user_id)).toEqual([w.a.owner.id]);
    await owner.close();
  } finally {
    await sql`update agency set sends_paused_at = null, sends_paused_reason = null where id = ${w.a.agencyId}`;
    await sql.end();
  }
});
