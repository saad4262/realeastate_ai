// PLATFORM-PLAN 4.6: the main pages on an iPhone (WebKit), an Android phone (Chromium) and a slow 3G connection.
// Each page must load, show its main content and never scroll sideways. Results: docs/TEST-PLAN.md "Devices".
import { chromium, devices, expect, test, webkit, type Browser, type BrowserType, type Page } from '@playwright/test';
import { world } from '../fixture';
import { urls } from '../playwright.config';
import { signIn } from './helpers';

const PHONES: { label: string; device: (typeof devices)[string]; engine: BrowserType }[] = [
  { label: 'iPhone 14 (Safari)', device: devices['iPhone 14'], engine: webkit },
  { label: 'Pixel 7 (Chrome)', device: devices['Pixel 7'], engine: chromium },
];

async function sideways(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function onPhone(phone: (typeof PHONES)[number], run: (page: Page) => Promise<void>) {
  let browser: Browser | null = null;
  try {
    browser = await phone.engine.launch();
    const page = await (await browser.newContext({ ...phone.device })).newPage();
    await run(page);
  } finally {
    await browser?.close();
  }
}

for (const phone of PHONES) {
  test.describe(phone.label, () => {
    test.skip(phone.engine === webkit && process.env.E2E_WEBKIT !== '1', 'Set E2E_WEBKIT=1 once `playwright install webkit` has run');

    test('public pages and sign-in: load, show their content, no sideways scroll', async () => {
      const w = world();
      const pages = [
        { name: 'home', url: `${urls.web}/`, main: 'main' },
        { name: 'search', url: `${urls.web}/search?state=VIC&suburb=Richmond`, main: 'main' },
        { name: 'listing', url: `${urls.web}/listing/${w.a.liveListingId}`, main: '#enquire' },
        { name: 'sign-in', url: `${urls.agent}/login`, main: 'form' },
      ];
      await onPhone(phone, async (page) => {
        for (const p of pages) {
          // Leave the last page first: a dev server's hot reload of it could otherwise cut the next navigation short.
          await page.goto('about:blank');
          await page.goto(p.url, { waitUntil: 'networkidle' });
          await expect(page.locator(p.main).first(), p.name).toBeVisible();
          expect.soft(await sideways(page), `${p.name} scrolls sideways`).toBeLessThanOrEqual(1);
        }
      });
    });

    test('the agent desk on a phone: leads and contacts', async () => {
      await onPhone(phone, async (page) => {
        await signIn(page, urls.agent, world().a.agent.email);
        for (const path of ['/my-leads', '/my-contacts']) {
          await page.goto(`${urls.agent}${path}`, { waitUntil: 'networkidle' });
          await expect(page.getByRole('heading', { level: 1 }).first(), path).toBeVisible();
          expect.soft(await sideways(page), `${path} scrolls sideways`).toBeLessThanOrEqual(1);
        }
        // The sidebar is a drawer on a phone: the menu opens it, a link goes there and closes it.
        const inbox = page.locator('#console-sidebar').getByRole('link', { name: 'Inbox' });
        await expect(inbox).not.toBeInViewport();
        await page.getByRole('button', { name: 'Open the menu' }).click();
        await expect(inbox).toBeInViewport();
        if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/phone-drawer-${phone.engine.name()}.png` });
        await inbox.click();
        await expect(page).toHaveURL(/\/my-inbox/);
        await expect(inbox).not.toBeInViewport();
      });
    });
  });
}

test('slow 3G (Chromium, Pixel 7): the listing page is readable within 15 seconds', async () => {
  await onPhone(PHONES[1]!, async (page) => {
    const cdp = await page.context().newCDPSession(page);
    // Chrome DevTools' "Slow 3G": 400 ms latency, 400 kbit/s down and up.
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 });
    const started = Date.now();
    await page.goto(`${urls.web}/listing/${world().a.liveListingId}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 60_000 });
    const readable = Date.now() - started;
    console.log(`slow 3G: listing headline visible after ${readable} ms`);
    expect(readable).toBeLessThan(15_000);
  });
});

test('desktop (1280 px): the sidebar is always there, no menu button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, urls.agent, world().a.agent.email);
  await page.goto(`${urls.agent}/my-leads`, { waitUntil: 'networkidle' });
  await expect(page.locator('#console-sidebar').getByRole('link', { name: 'Inbox' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Open the menu' })).toBeHidden();
});
