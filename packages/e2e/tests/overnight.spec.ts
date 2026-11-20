// PLATFORM-PLAN 3.7: the owner sees last night's failures on the Overview; a text held by a pause and an old failure
// are not counted, and agency B's failures never show.
import { expect, test } from '@playwright/test';
import { sqlClient, world } from '../fixture';
import { urls } from '../playwright.config';
import { signIn } from './helpers';

const PAUSED = "Not sent: this agency's sends are paused. An owner or admin can resume them.";

test('last night: one failed text shows for the owner; a paused one, an old one and agency B’s do not', async ({ page }) => {
  const w = world();
  const sql = sqlClient();
  try {
    const sid = `PN${w.tag}`;
    const [na] = await sql`insert into phone_number (agency_id, user_id, e164, number_sid, status) values (${w.a.agencyId}, ${w.a.agent.id}, '+61400000101', ${`${sid}a`}, 'inactive') returning id`;
    const [nb] = await sql`insert into phone_number (agency_id, user_id, e164, number_sid, status) values (${w.b.agencyId}, ${w.b.agent.id}, '+61400000102', ${`${sid}b`}, 'inactive') returning id`;
    await sql`insert into sms_message (agency_id, phone_number_id, counterpart, direction, body, status, error, updated_at) values
      (${w.a.agencyId}, ${na!.id}, '+61400000999', 'out', 'e2e', 'failed', 'Twilio refused it', now() - interval '1 hour'),
      (${w.a.agencyId}, ${na!.id}, '+61400000999', 'out', 'e2e', 'failed', ${PAUSED}, now() - interval '1 hour'),
      (${w.a.agencyId}, ${na!.id}, '+61400000999', 'out', 'e2e', 'failed', 'Twilio refused it', now() - interval '3 days'),
      (${w.b.agencyId}, ${nb!.id}, '+61400000999', 'out', 'e2e', 'failed', 'Twilio refused it', now() - interval '1 hour'),
      (${w.b.agencyId}, ${nb!.id}, '+61400000999', 'out', 'e2e', 'failed', 'Twilio refused it', now() - interval '1 hour')`;

    await signIn(page, urls.agency, w.a.owner.email);
    await page.goto(`${urls.agency}/overview`);
    const card = page.locator('section[aria-labelledby="overnight-heading"]');
    await expect(card).toContainText('what did not go through');
    await expect(card.getByRole('link', { name: '1 text was not sent' })).toHaveAttribute('href', '/inbox/texts');
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/overnight.png` });
  } finally {
    await sql.end();
  }
});
