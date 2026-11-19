import { expect, type Page } from '@playwright/test';
import { PASSWORD } from '../fixture';

export async function signIn(page: Page, base: string, email: string) {
  await page.goto(`${base}/login`);
  await page.locator('#agency-email').fill(email);
  await page.locator('#agency-password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 90_000 });
}
