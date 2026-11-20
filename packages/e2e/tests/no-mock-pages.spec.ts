// O-40: the "LocalAgent AI" design mock is gone: /ai opens the Overview, and the sidebar no longer offers it.
import { expect, test } from '@playwright/test';
import { world } from '../fixture';
import { urls } from '../playwright.config';
import { signIn } from './helpers';

test('/ai opens the Overview; no "LocalAgent AI" in the sidebar; no made-up figures on the way', async ({ page }) => {
  await signIn(page, urls.agency, world().a.owner.email);
  await page.goto(`${urls.agency}/ai`);
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.locator('#console-sidebar').getByRole('link', { name: /LocalAgent AI/ })).toHaveCount(0);
  await expect(page.getByText(/data points\/sec|GPT-RealEstate|ms Mesh/)).toHaveCount(0);
});
