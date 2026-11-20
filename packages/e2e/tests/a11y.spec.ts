// PLATFORM-PLAN 4.5: axe on the five E2E pages (and the two sign-in pages): no serious or critical issue.
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { world } from '../fixture';
import { urls } from '../playwright.config';
import { signIn } from './helpers';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

type Violation = { id: string; impact: string | null; help: string; nodes: { target: string[] }[] };

async function serious(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: Violation[] }> } }).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return r.violations;
  });
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test('sign-in pages', async ({ page }) => {
  for (const url of [`${urls.web}/login`, `${urls.agency}/login`]) {
    await page.goto(url, { waitUntil: 'networkidle' });
    expect.soft(await serious(page), url).toEqual([]);
  }
});

test('the public listing page', async ({ page }) => {
  await page.goto(`${urls.web}/listing/${world().a.liveListingId}`, { waitUntil: 'networkidle' });
  expect.soft(await serious(page)).toEqual([]);
});

test('the agent desk: contacts, leads, a contacts import', async ({ page }) => {
  await signIn(page, urls.agent, world().a.agent.email);
  for (const path of ['/my-contacts', '/my-leads', '/my-contacts/import']) {
    await page.goto(`${urls.agent}${path}`, { waitUntil: 'networkidle' });
    expect.soft(await serious(page), path).toEqual([]);
  }
});

test('the agency console: listings', async ({ page }) => {
  await signIn(page, urls.agency, world().a.owner.email);
  await page.goto(`${urls.agency}/live-listings`, { waitUntil: 'networkidle' });
  expect.soft(await serious(page)).toEqual([]);
});
