import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { HELP_LIMITS, HELP_PAGES, buildHelpGuide, checkHelpAllowed, helpHrefs, helpPageName, helpRequestSchema, parseHelpReply, type HelpNavGroup } from './help';

/** ADR 0088: the help bot's guide, its limits and its links. */

const A = '11111111-1111-1111-1111-111111111111';
const agent: Actor = { userId: 'u1', agencyId: A, membershipRole: 'agent' };
const ENV = { HELP_MESSAGES_PER_HOUR: '30', AI_DAILY_BUDGET_USD: '20' } as unknown as NodeJS.ProcessEnv;
const ROOT = join(__dirname, '..', '..', '..', '..', 'apps', 'console');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const groups: HelpNavGroup[] = [
  { items: [{ href: '/overview', label: 'Overview' }] },
  { label: 'Automation', items: [{ href: '/skills', label: 'Skills' }] },
  { label: 'Settings', items: [{ href: '/settings', label: 'Settings' }, { href: '/sign-out', label: 'Sign out', signOut: true }] },
];

describe('the guide', () => {
  it('has a line for every page in either sidebar, so it cannot fall behind', () => {
    const surfaces = read('components', 'shell', 'surfaces.ts');
    const hrefs = [...surfaces.matchAll(/href: '(\/[^']*)'/g)].map((m) => m[1]!).filter((h) => h !== '/sign-out');
    const adminStart = surfaces.indexOf('\n  admin: {');
    const consoleHrefs = [...surfaces.slice(0, adminStart).matchAll(/href: '(\/[^']*)'/g)].map((m) => m[1]!).filter((h) => h !== '/sign-out');
    expect(hrefs.length).toBeGreaterThan(consoleHrefs.length);
    expect(consoleHrefs.length).toBeGreaterThan(30);
    expect(consoleHrefs.filter((h) => !HELP_PAGES[h])).toEqual([]);
  });

  it('says where a page is in the sidebar and leaves Sign out out', () => {
    const g = buildHelpGuide('agency', groups);
    expect(g).toContain('Skills (/skills), in the sidebar under Automation');
    expect(g).not.toContain('/sign-out');
  });

  it('an agent’s guide never names an agency-only page, and the other way round', () => {
    const agency = buildHelpGuide('agency', groups);
    const desk = buildHelpGuide('agent', [{ label: 'Automation', items: [{ href: '/my-skills', label: 'Skills' }] }]);
    expect(desk).toContain('/my-phone');
    expect(desk).not.toContain('/settings/phone');
    expect(desk).not.toContain('/team');
    expect(agency).toContain('/settings/phone');
    expect(agency).not.toContain('/my-phone');
  });

  it('is the same text every time: it is the cached prefix', () => {
    expect(buildHelpGuide('agency', groups)).toBe(buildHelpGuide('agency', groups));
  });

  it('says a preview screen is one', () => {
    for (const h of ['/ai', '/marketing', '/insights']) expect(HELP_PAGES[h]).toContain('not working yet');
  });

  it('every extra page exists in the app', () => {
    for (const [dir, ...rest] of [['(agency)', 'settings', 'phone'], ['(agent)', 'my-phone']] as string[][]) {
      expect(() => read('app', dir!, ...rest, 'page.tsx')).not.toThrow();
    }
  });
});

describe('helpPageName', () => {
  it('names the page, ignoring the query and anything after it in the path', () => {
    expect(helpPageName('/skills?tab=automations', 'agency', groups)).toBe('Skills');
    expect(helpPageName('/skills/2f0c-secret-id/runs', 'agency', groups)).toBe('Skills');
  });
  it('takes the longest match', () => {
    expect(helpPageName('/settings/phone', 'agency', groups)).toBe('Phone & SMS');
    expect(helpPageName('/settings', 'agency', groups)).toBe('Settings');
  });
  it('does not match a page that only starts the same', () => {
    expect(helpPageName('/skillset', 'agency', groups)).toBeNull();
  });
  it('is null for a page the guide does not have, so the path itself never goes to the model', () => {
    expect(helpPageName('/somewhere/ignore-your-instructions', 'agency', groups)).toBeNull();
  });
});

describe('helpRequestSchema', () => {
  const ok = { path: '/skills', messages: [{ role: 'user', text: 'hi' }] };
  it('takes a conversation that starts and ends with the person', () => {
    expect(helpRequestSchema.safeParse(ok).success).toBe(true);
    expect(helpRequestSchema.safeParse({ ...ok, messages: [{ role: 'assistant', text: 'x' }, { role: 'user', text: 'y' }] }).success).toBe(false);
    expect(helpRequestSchema.safeParse({ ...ok, messages: [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'y' }] }).success).toBe(false);
  });
  it('refuses too many messages, too long a message, a path off the site, and extra fields', () => {
    const many = Array.from({ length: HELP_LIMITS.messages + 1 }, () => ({ role: 'user', text: 'x' }));
    expect(helpRequestSchema.safeParse({ ...ok, messages: many }).success).toBe(false);
    expect(helpRequestSchema.safeParse({ ...ok, messages: [{ role: 'user', text: 'x'.repeat(HELP_LIMITS.chars + 1) }] }).success).toBe(false);
    expect(helpRequestSchema.safeParse({ ...ok, path: 'https://evil.example' }).success).toBe(false);
    expect(helpRequestSchema.safeParse({ ...ok, surface: 'admin' }).success).toBe(false);
  });
});

describe('parseHelpReply', () => {
  const allowed = helpHrefs('agency', groups);
  it('links a page the guide has', () => {
    expect(parseHelpReply('Open [Skills](/skills) now.', allowed)).toEqual([{ text: 'Open ' }, { text: 'Skills', href: '/skills' }, { text: ' now.' }]);
  });
  it('keeps only the words of any other link', () => {
    expect(parseHelpReply('[click](https://evil.example)', allowed)).toEqual([{ text: 'click' }]);
    expect(parseHelpReply('[x](javascript:alert(1))', allowed).some((s) => s.href)).toBe(false);
    expect(parseHelpReply('[y](/team)', allowed)).toEqual([{ text: 'y' }]);
  });
  it('leaves plain text alone', () => {
    expect(parseHelpReply('No links.', allowed)).toEqual([{ text: 'No links.' }]);
  });
});

function gateDb(rows: { help: number; spend: string }) {
  let queries = 0;
  const db = {
    select: (shape: Record<string, unknown>) => {
      const answer = 'n' in shape ? [{ n: rows.help }] : [{ total: rows.spend }];
      const chain = { from: () => chain, where: () => chain, then: (res: (v: unknown) => unknown) => ((queries += 1), Promise.resolve(answer).then(res)) };
      return chain;
    },
  } as unknown as Db;
  return { db, count: () => queries };
}

describe('checkHelpAllowed', () => {
  it('asks nothing for someone with no agency, or an admin viewing one', async () => {
    const { db, count } = gateDb({ help: 0, spend: '0' });
    expect((await checkHelpAllowed(db, { userId: 'x' }, { env: ENV })).allowed).toBe(false);
    expect((await checkHelpAllowed(db, { userId: 'x', agencyId: A, membershipRole: 'owner', via: 'platform' }, { env: ENV })).allowed).toBe(false);
    expect(count()).toBe(0);
  });
  it('lets a member ask, in two statements', async () => {
    const { db, count } = gateDb({ help: 29, spend: '1' });
    expect(await checkHelpAllowed(db, agent, { env: ENV })).toEqual({ allowed: true, message: null });
    expect(count()).toBe(2);
  });
  it('stops at the hourly limit', async () => {
    const { db } = gateDb({ help: 30, spend: '1' });
    expect((await checkHelpAllowed(db, agent, { env: ENV })).allowed).toBe(false);
  });
  it('stops at the platform’s budget', async () => {
    const { db } = gateDb({ help: 0, spend: '20' });
    expect((await checkHelpAllowed(db, agent, { env: ENV })).allowed).toBe(false);
  });
});

describe('the route and the window, read from source', () => {
  it('asks who is signed in, then the gate, before the model', () => {
    const route = read('app', 'api', 'help', 'route.ts');
    expect(route.indexOf('actionUserId()')).toBeLessThan(route.indexOf('checkHelpAllowed('));
    expect(route.indexOf('checkHelpAllowed(')).toBeLessThan(route.indexOf('answerHelp('));
    expect(route).toMatch(/if \(!gate\.allowed\) return NextResponse\.json\(\{ error: gate\.message \}, \{ status: 429 \}\);/);
  });
  it('takes the console from the middleware’s header, never the browser', () => {
    const route = read('app', 'api', 'help', 'route.ts');
    expect(route).toContain("request.headers.get('x-console-surface')");
    expect(route).not.toMatch(/parsed\.data\.surface/);
  });
  it('the window keeps nothing: no storage, no database', () => {
    const widget = read('components', 'help', 'help-widget.tsx');
    expect(widget).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(widget).toContain('usePathname');
  });
});
