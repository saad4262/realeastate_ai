// PLATFORM-PLAN 1.16: API routes answer errors as { error: { code, message } }, and the pages show the message.
import { expect, test } from '@playwright/test';
import { urls } from '../playwright.config';

test('a route answers a bad request in the one error shape', async ({ request }) => {
  const res = await request.post(`${urls.web}/api/research`, { data: { kind: 'nonsense' } });
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ error: { code: 'bad_request', message: 'That request could not be understood.' } });
});

test('a page shows the message from an error answer', async ({ page }) => {
  // The model is not called: the answer is the route's error, as it would come back with the AI resting.
  await page.route('**/api/research', (r) =>
    r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'The AI is resting for today. Every figure is still on the page.' } }) }),
  );
  await page.goto(`${urls.web}/suburb/vic/richmond`);
  await page.getByRole('button', { name: 'Summarise with AI' }).click();
  await expect(page.getByText('The AI is resting for today. Every figure is still on the page.')).toBeVisible();
});
