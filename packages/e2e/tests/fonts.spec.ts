// Fonts are self-hosted: no request to Google's font hosts, and the console's icons draw as glyphs, not their names.
import { expect, test } from '@playwright/test';
import { urls } from '../playwright.config';

for (const [name, url] of [['web', `${urls.web}/`], ['console', `${urls.agency}/login`]] as const) {
  test(`${name}: every font comes from this origin`, async ({ page }) => {
    const google: string[] = [];
    page.on('request', (r) => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) google.push(r.url()); });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    expect(google).toEqual([]);
  });
}

test('console: an icon draws as a 24 px glyph', async ({ page }) => {
  await page.goto(`${urls.agency}/login`, { waitUntil: 'networkidle' });
  const width = await page.evaluate(async () => {
    const el = Object.assign(document.createElement('span'), { className: 'material-symbols-outlined', textContent: 'home' });
    document.body.append(el);
    await document.fonts.load("24px 'Material Symbols Outlined'", 'home');
    return el.getBoundingClientRect().width;
  });
  expect(width).toBeLessThan(40); // the word "home" in a fallback face is about 60 px
});
