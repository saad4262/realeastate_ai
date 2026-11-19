import { defineConfig } from '@playwright/test';

/**
 * PLATFORM-PLAN 4.1. Locally: the web app on :3000 and the console on :3001 (`pnpm dev`), on the DEV database;
 * agents.lvh.me / agency.lvh.me reach the console's two surfaces. In CI: the preview URLs (E2E_WEB, E2E_AGENT,
 * E2E_AGENCY). One worker: the tests share one seeded world. A dev server compiles a page on first visit (slow).
 */
export const urls = {
  web: process.env.E2E_WEB ?? 'http://localhost:3000',
  agent: process.env.E2E_AGENT ?? 'http://agents.lvh.me:3001',
  agency: process.env.E2E_AGENCY ?? 'http://agency.lvh.me:3001',
};

export default defineConfig({
  testDir: './tests',
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: { navigationTimeout: 120_000, trace: 'retain-on-failure' },
});
