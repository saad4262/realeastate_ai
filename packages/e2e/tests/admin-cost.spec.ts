// PLATFORM-PLAN 2.7: the admin's AI cost page shows each agency's spend and credit grants; an agency's period adds
// up to its own ai_run rows.
import { expect, test } from '@playwright/test';
import { sqlClient, world } from '../fixture';
import { passwordSession, useSession } from './helpers';

const admin = process.env.E2E_ADMIN ?? 'http://admin.lvh.me:3001';

test('AI cost: agency A’s spend is the sum of its ai_run rows, and its grant shows with what is left', async ({ page, context }) => {
  const w = world();
  const sql = sqlClient();
  let runs: string[] = [];
  try {
    runs = (
      await sql`insert into ai_run (agency_id, feature, model, cost_usd) values
        (${w.a.agencyId}, 'assistant', 'claude-sonnet-5-5', 0.1), (${w.a.agencyId}, 'inbox:draft', 'claude-sonnet-5-5', 0.25)
        returning id`
    ).map((r) => r.id as string);
    await sql`insert into ai_credit_grant (agency_id, credits, used, source, valid_from, expires_at)
      values (${w.a.agencyId}, 1000, 35, 'plan', now() - interval '1 day', now() + interval '30 days')`;
    const [own] = await sql`select coalesce(sum(cost_usd), 0)::float8 as spend from ai_run where agency_id = ${w.a.agencyId} and created_at >= now() - interval '30 days'`;

    await useSession(context, admin, await passwordSession(w.admin.email));
    await page.goto(`${admin}/ai-cost/${w.a.agencyId}?days=30`);
    const stat = page.locator('[class*="stat"]').filter({ has: page.getByText('Spend', { exact: true }) }).first();
    await expect(stat).toContainText(`$${Number(own!.spend).toFixed(2)}`);
    await expect(page.getByText('965 credits ($9.65) left in grants in force')).toBeVisible();
    await expect(page.getByRole('row', { name: /Plan allowance.*1,000.*35/ })).toBeVisible();
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/admin-cost-agency.png`, fullPage: true });

    await page.goto(`${admin}/ai-cost?days=30`);
    await expect(page.getByRole('row', { name: new RegExp(`E2E a ${w.tag}.*965 credits \\(\\$9\\.65\\) of 1,000`) })).toBeVisible();
  } finally {
    if (runs.length) await sql`delete from ai_run where id in ${sql(runs)}`;
    await sql.end();
  }
});
