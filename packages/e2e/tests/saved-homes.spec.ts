// ADR 0100: save a home from its page, signed out first (sign in, come back, it is saved), then the Saved page:
// it is listed, opens, keeps a note, removes with Undo, and the empty state and toast read as sentences.
import { expect, test, type Locator } from '@playwright/test';
import { person, PASSWORD, sqlClient, world } from '../fixture';
import { urls } from '../playwright.config';

const BRAND = 'rgb(225, 29, 72)'; // --color-brand, the site's red
/** A one-word-per-line column is what a spacing token in max-w-* drew (max-w-sm = 0.5rem); a sentence is wider. */
const wide = async (l: Locator) => expect((await l.boundingBox())!.width).toBeGreaterThan(240);

test('save a home signed out, sign in, find it on the Saved page; note, open, remove, Undo', async ({ page }) => {
  const w = world();
  const sql = sqlClient();
  try {
    await person(sql, `${w.tag}-saver@e2e.test`);
  } finally {
    await sql.end();
  }
  const home = `${urls.web}/listing/${w.a.liveListingId}`;
  const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

  // Signed out: the heart says so, and sends to sign-in with the way back.
  await page.goto(home);
  await page.getByRole('button', { name: 'Sign in to save' }).click();
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.locator('#email').fill(`${w.tag}-saver@e2e.test`);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#password').press('Enter');

  // Back on the home, the press is kept: saved, in the site's red, and said once.
  await expect(page).toHaveURL(home);
  const heart = page.getByRole('button', { name: 'Saved', exact: true });
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect(heart).toHaveCSS('color', BRAND);
  const toast = page.getByRole('status').locator('div').filter({ hasText: 'Home saved' });
  await expect(toast).toBeVisible();
  await expect(heart.locator('svg')).not.toHaveCSS('animation-name', /pop/); // saved on arrival: nothing pops

  // Unsave, save again by hand: that one pops.
  await heart.click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('status')).toContainText('Removed from saved homes');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect(heart.locator('svg')).toHaveCSS('animation-name', /pop/);
  await expect(toast).toBeVisible();
  await wide(toast);
  await shot('1-saved-on-listing');

  // The Saved page lists it.
  await toast.getByRole('link', { name: 'View saved' }).click();
  await expect(page).toHaveURL(/\/account\/shortlist$/);
  const link = page.getByRole('link', { name: /E2E Street/ });
  await expect(link).toBeVisible();
  const remove = page.getByRole('button', { name: /^Remove .*E2E Street from saved$/ });
  await expect(remove).toHaveCSS('color', BRAND);
  // This site has no Tailwind preflight: a button left to the browser has a grey border, a <p> a 1em margin.
  await expect(remove).toHaveCSS('border-top-width', '0px');
  await expect(page.getByText('Richmond VIC')).toHaveCSS('margin-top', '0px');
  await expect(page.getByText('1 home · only you can see this list')).toBeVisible();

  // A private note.
  await page.getByRole('button', { name: 'Add a private note' }).click();
  await page.getByRole('textbox').fill('Check the train noise');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('“Check the train noise”')).toBeVisible();
  await shot('2-saved-page');

  // The card opens the home.
  await link.click();
  await expect(page).toHaveURL(home);
  await page.goBack();

  // Remove, then Undo: back with its note.
  await page.getByRole('button', { name: /^Remove .*E2E Street from saved$/ }).click();
  await expect(page.getByRole('heading', { name: 'No saved homes yet' })).toBeVisible();
  await expect(page.getByText('Only you can see this list.')).toBeVisible(); // the count moves with the list, not after it
  await expect(page.getByRole('link', { name: 'Plan inspections' })).toHaveCount(0);
  await wide(page.getByText('Press the heart on any home'));
  const removed = page.getByRole('status').locator('div').filter({ hasText: 'Removed' });
  await wide(removed);
  await expect(removed.getByRole('button', { name: 'Undo' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await shot('3-removed-empty');
  await removed.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('“Check the train noise”')).toBeVisible();
  await expect(page.getByRole('link', { name: /E2E Street/ })).toBeVisible();
});
