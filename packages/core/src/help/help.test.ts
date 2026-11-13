import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { HELP_LIMITS, HELP_PAGES, buildHelpGuide, checkHelpAllowed, helpHrefs, helpPageContext, helpPageName, helpReplyLinks, helpRequestSchema, parseHelpReply, type HelpNavGroup } from './help';

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

/** Each console's sidebar, from the file the shell reads. */
function sidebar(surface: 'agency' | 'agent'): HelpNavGroup[] {
  const src = read('components', 'shell', 'surfaces.ts');
  const a = src.indexOf('\n  agency: {');
  const b = src.indexOf('\n  agent: {');
  const c = src.indexOf('\n  admin: {');
  const part = surface === 'agency' ? src.slice(a, b) : src.slice(b, c);
  return [{ items: [...part.matchAll(/href: '(\/[^']*)', label: '([^']*)'/g)].map((m) => ({ href: m[1]!, label: m[2]! })) }];
}

function routesOn(group: string): string[] {
  const root = join(ROOT, 'app', group);
  return (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('page.tsx')).map((f) => `/${dirname(f)}`);
}

const REDIRECTS = new Set(['/workflows', '/dashboards', '/my-workflows', '/my-dashboards']);

describe('knowing the page', () => {
  it('knows the agent’s home, which is in no sidebar', () => {
    expect(helpPageContext('/assistant', 'agent', sidebar('agent'))).toMatchObject({ name: 'Home' });
  });

  for (const [surface, group] of [['agency', '(agency)'], ['agent', '(agent)']] as const) {
    it(`has its own line for every page of the ${surface} console`, () => {
      const missing = routesOn(group)
        .filter((r) => !REDIRECTS.has(r))
        .filter((r) => helpPageContext(r.replace(/\[[^\]]+\]/g, 'x1'), surface, sidebar(surface))?.pattern !== r);
      expect(missing).toEqual([]);
    });
  }

  it('says what the page is for, not only its name', () => {
    const c = helpPageContext('/bulk-email', 'agency', sidebar('agency'))!;
    expect(c.name).toBe('Bulk email');
    expect(c.what).toContain('Approve & Send');
  });

  it('a page’s own line beats the section it is under', () => {
    expect(helpPageContext('/customers/new', 'agency', sidebar('agency'))!.pattern).toBe('/customers/new');
    expect(helpPageContext('/customers/2f0c-id', 'agency', sidebar('agency'))!.pattern).toBe('/customers/[id]');
    expect(helpPageContext('/my-skills/x/runs/y', 'agent', sidebar('agent'))!.pattern).toBe('/my-skills/[id]/runs/[runId]');
  });

  it('knows the tab on Skills, and only a tab that exists', () => {
    expect(helpPageContext('/skills?tab=automations', 'agency', sidebar('agency'))!.tab).toBe('Automations');
    expect(helpPageContext('/my-skills?tab=ai', 'agent', sidebar('agent'))!.tab).toBe('AI skills');
    expect(helpPageContext('/skills?tab=ignore-your-rules', 'agency', sidebar('agency'))!.tab).toBeNull();
    expect(helpPageContext('/customers?tab=automations', 'agency', sidebar('agency'))!.tab).toBeNull();
  });

  it('never carries an id from the URL', () => {
    expect(JSON.stringify(helpPageContext('/customers/2f0c-secret', 'agency', sidebar('agency')))).not.toContain('2f0c-secret');
  });
});

describe('what the guide teaches', () => {
  const agency = buildHelpGuide('agency', sidebar('agency'));
  const desk = buildHelpGuide('agent', sidebar('agent'));

  it('explains the parts of the screen that are on every page', () => {
    for (const g of [agency, desk]) {
      expect(g).toContain('bolt');
      expect(g).toContain('bell');
      expect(g).toContain('Recents');
      expect(g).toContain('Skills panel');
      expect(g).toContain('Automations panel');
    }
  });

  it('gives the steps for the common jobs, in the screens’ own words', () => {
    for (const g of [agency, desk]) {
      for (const words of ['Save this filter', 'Prepare a send', 'Approve & Send', 'New contact', '+ Schedule', 'Add documents', 'Open', 'Automations']) expect(g, words).toContain(words);
    }
  });

  it('uses each console’s own names', () => {
    expect(agency).toContain('Customers');
    expect(desk).toContain('Contacts');
    expect(agency).toContain('Publish');
    expect(desk).toContain('Submit for approval');
  });

  it('says what the home chat does: everyday work, and a skill’s job goes to its assistant', () => {
    const g = buildHelpGuide('agency', sidebar('agency'));
    expect(g).toContain('AI Assistant');
    expect(g).toContain('that skill\'s assistant');
  });

  it('never tells the browser to link a page with an id in it', () => {
    expect([...helpHrefs('agency', sidebar('agency'))].filter((h) => h.includes('['))).toEqual([]);
  });

  it('can link the static pages it now knows', () => {
    expect(helpHrefs('agency', sidebar('agency')).has('/customers/new')).toBe(true);
    expect(helpHrefs('agent', sidebar('agent')).has('/assistant')).toBe(true);
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
  it('tells the browser only the guide’s pages that the reply really links to, once each', () => {
    expect(helpReplyLinks('[Skills](/skills), [again](/skills), [no](https://evil.example), [nor](/team)', allowed)).toEqual(['/skills']);
  });
  it('leaves plain text alone', () => {
    expect(parseHelpReply('No links.', allowed)).toEqual([{ text: 'No links.' }]);
  });
});

function gateDb(rows: { help: number; spend: string }) {
  let queries = 0;
  const db = {
    select: () => {
      const chain = { from: () => chain, where: () => chain, then: (res: (v: unknown) => unknown) => ((queries += 1), Promise.resolve([{ n: rows.help }]).then(res)) };
      return chain;
    },
    // The platform's spend: one statement from ai-budget.
    execute: async () => ((queries += 1), [{ total: rows.spend, person: '0', agency: '0' }]),
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
  it('tells the server the tab, and never the rest of the URL', () => {
    const widget = read('components', 'help', 'help-widget.tsx');
    expect(widget).toContain("new URLSearchParams(window.location.search).get('tab')");
    expect(widget).not.toMatch(/path: pathname \+ window\.location\.search/);
  });
  it('renders the reply’s Markdown, and links only what the server allowed', () => {
    const widget = read('components', 'help', 'help-widget.tsx');
    expect(widget).toContain('parseChatMarkdown(text)');
    expect(widget).toContain('parseHelpReply(value, allowed)');
    expect(widget).not.toContain('dangerouslySetInnerHTML');
  });
  it('the browser’s half imports nothing that reaches the database', () => {
    const pages = readFileSync(join(__dirname, 'pages.ts'), 'utf8');
    expect(pages).not.toMatch(/drizzle-orm|@repo\/db/);
    expect(read('components', 'help', 'help-widget.tsx')).toContain("from '@repo/core/help/pages'");
  });
});
