// PLATFORM-PLAN 1.20: an owner reads the agency's audit log in words, with names; another agency's rows never show.
import { expect, test } from '@playwright/test';
import { sqlClient, world } from '../fixture';
import { urls } from '../playwright.config';
import { signIn } from './helpers';

test('the audit log: the owner sees who did what to whom; agency B’s entry is not there', async ({ page }) => {
  const w = world();
  const sql = sqlClient();
  try {
    await sql`insert into audit_log (agency_id, actor_user_id, action, subject_user_id, detail) values
      (${w.a.agencyId}, ${w.a.owner.id}, 'member_edited', ${w.a.agent.id}, ${sql.json({ fields: ['phone'] })}),
      (${w.a.agencyId}, null, 'sends_paused', null, ${sql.json({ reason: 'Far above this agency’s usual: texts 99 this hour.' })}),
      (${w.b.agencyId}, ${w.b.agent.id}, 'listing_deleted', null, ${sql.json({ status: 'withdrawn' })})`;
    await signIn(page, urls.agency, w.a.owner.email);
    await page.goto(`${urls.agency}/settings/audit`);
    const table = page.getByRole('table');
    await expect(table.getByRole('row', { name: new RegExp(`${w.tag}-owner.*Edited ${w.tag}-agent \\(phone\\)`) })).toBeVisible();
    await expect(table.getByRole('row', { name: /Automatic.*Sends paused automatically: Far above/ })).toBeVisible();
    await expect(table.getByText('it was withdrawn')).toHaveCount(0);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/audit-log.png` });
  } finally {
    await sql.end();
  }
});
