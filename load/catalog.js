// PLATFORM-PLAN 4.3: every request the load test makes, in one place — who makes it, what it stands for, which code
// answers it, how often, and its budget. Read by platform.js (k6), profile.mjs (one call of each, alone) and
// report.mjs. Plain ES module: k6 and Node both import it. No AI route is here (each call costs tokens) and no Google
// route (/api/places): they are measured separately.

export const ROLES = {
  visitor: { label: 'Public visitor', who: 'Anonymous buyer or renter browsing the public site', app: 'web' },
  buyer: { label: 'Signed-in buyer', who: 'A site account holder: their account, shortlist, alerts and messages', app: 'web' },
  agent: { label: 'Agent', who: 'An agent at work in the console (agents.* surface): their own contacts, leads and listings', app: 'console' },
  owner: { label: 'Agency owner', who: 'An agency owner or admin (agency.* surface): the whole agency\'s data', app: 'console' },
  admin: { label: 'Platform admin', who: 'Our own staff (admin.* surface): every agency, read-only, every view logged', app: 'console' },
  system: { label: 'Systems', who: 'Machines: payment webhooks and uptime monitors', app: 'web' },
};

// People online at once (change with -e AGENCIES=… AGENTS=… USERS=… on the k6 command line).
// AGENTS counts every console member; one per agency is its owner. BUYER_SHARE of USERS are signed in.
export function population(env) {
  const agencies = Number(env.AGENCIES || 200);
  const agents = Number(env.AGENTS || 1000);
  const users = Number(env.USERS || 10000);
  const buyerShare = Number(env.BUYER_SHARE || 0.1);
  return { agencies, owners: agencies, agents: Math.max(0, agents - agencies), buyers: users * buyerShare, visitors: users * (1 - buyerShare), admins: Number(env.ADMINS || 2) };
}

// Habits (requests a person makes a MINUTE): a visitor or buyer opens a page every 30 s; console tabs open a page
// every 30 s, poll /api/live every 5 s and the bell every 60 s; 1 agent in 5 has the inbox open (pulled every 20 s);
// an admin opens a page a minute; each listing view and search sends one activity beacon; a buyer's tab pings
// presence once a minute.
const PER_MIN = { page: 2, live: 12, bell: 1, inbox: 0.2 * 3, adminPage: 1, ping: 1 };

const slug = (path) => path.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '_').replace(/_$/, '') || 'home';
const pages = (role, paths, share, does, code, budget) =>
  paths.map((path) => ({ kind: `${role}_${slug(path)}`, role, method: 'GET', path, perMin: (p) => share(p) / paths.length, budget, does: does(path), code: code(path) }));

const AGENT_PAGES = ['/my-contacts', '/my-leads', '/listings', '/my-calendar', '/my-inbox', '/my-pipeline', '/my-properties', '/my-messages', '/my-listing-activity', '/my-commission'];
const OWNER_PAGES = ['/customers', '/leads', '/live-listings', '/pipeline', '/team', '/inbox', '/calendar', '/finance', '/insights', '/properties', '/listing-activity'];
const ADMIN_PAGES = ['/platform', '/agencies', '/agencies/{agency}', '/agents', '/users', '/site-activity', '/ai-cost'];
const BUYER_PAGES = ['/account', '/account/shortlist', '/account/watching', '/account/messages', '/alerts'];
const visitorPages = (p) => (p.visitors * PER_MIN.page);

export const ENDPOINTS = [
  // Public visitor
  { kind: 'visitor_listing', role: 'visitor', method: 'GET', path: '/listing/{listing}', perMin: (p) => visitorPages(p) * 0.4, budget: 200,
    does: 'Opens a listing ad: the listing, photos, agents, inspections, nearby sales (cached 60 s per listing)', code: 'apps/web/app/listing/[id]/page.tsx' },
  { kind: 'visitor_search', role: 'visitor', method: 'GET', path: '/search?q={suburb}', perMin: (p) => visitorPages(p) * 0.25, budget: 500,
    does: 'Searches a suburb: matching listings and facets (cached 30 s per query)', code: 'apps/web/app/search/page.tsx, core/listings/search-listings.ts' },
  { kind: 'visitor_home', role: 'visitor', method: 'GET', path: '/', perMin: (p) => visitorPages(p) * 0.1, budget: 200,
    does: 'The home page (ISR, rebuilt every 5 minutes)', code: 'apps/web/app/page.tsx' },
  { kind: 'visitor_sold', role: 'visitor', method: 'GET', path: '/sold?q={suburb}', perMin: (p) => visitorPages(p) * 0.1, budget: 500,
    does: 'Recent sales in a suburb', code: 'apps/web/app/sold/page.tsx' },
  { kind: 'visitor_property', role: 'visitor', method: 'GET', path: '/property/{property}', perMin: (p) => visitorPages(p) * 0.1, budget: 500,
    does: 'An address\'s history page: past campaigns, sales, timeline', code: 'apps/web/app/property/[id]/page.tsx' },
  { kind: 'visitor_suburb', role: 'visitor', method: 'GET', path: '{suburbPath}', perMin: (p) => visitorPages(p) * 0.05, budget: 200,
    does: 'A suburb profile page (ISR, rebuilt hourly)', code: 'apps/web/app/suburb/[state]/[suburb]/page.tsx' },
  { kind: 'visitor_beacon', role: 'visitor', method: 'POST', path: '/api/activity', perMin: (p) => visitorPages(p) * 0.65, budget: 100,
    does: 'The browser\'s activity beacon after a listing view or a search: one insert into site_activity', code: 'apps/web/app/api/activity/route.ts' },

  // Signed-in buyer
  ...pages('buyer', BUYER_PAGES, (p) => p.buyers * PER_MIN.page, (path) => `Their account page ${path}`, (path) => `apps/web/app${path}/page.tsx`, 800),
  { kind: 'buyer_ping', role: 'buyer', method: 'POST', path: '/api/activity', perMin: (p) => p.buyers * PER_MIN.ping, budget: 100,
    does: 'Presence ping from an open tab: last seen, at most one write a minute', code: 'apps/web/app/api/activity/route.ts' },

  // Agent
  ...pages('agent', AGENT_PAGES, (p) => p.agents * PER_MIN.page, (path) => `Console page ${path}, only their own records`, (path) => `apps/console/app/(agent)${path}/page.tsx`, 800),
  { kind: 'agent_live', role: 'agent', method: 'GET', path: '/api/live', perMin: (p) => p.agents * PER_MIN.live, budget: 100,
    does: 'The 5-second "anything new?" poll of every open console tab: one stamp query, last seen at most once a minute', code: 'apps/console/app/api/live/route.ts, core/mail/live.ts' },
  { kind: 'agent_bell', role: 'agent', method: 'GET', path: '/api/notifications', perMin: (p) => p.agents * PER_MIN.bell, budget: 300,
    does: 'The bell: their latest notifications, every minute', code: 'apps/console/app/api/notifications/route.ts' },
  { kind: 'agent_inbox_pull', role: 'agent', method: 'POST', path: '/api/mail/sync', perMin: (p) => p.agents * PER_MIN.inbox, budget: 500,
    does: 'The inbox\'s mail pull every 20 s (at most one real pull per server per 10 s)', code: 'apps/console/app/api/mail/sync/route.ts' },

  // Agency owner
  ...pages('owner', OWNER_PAGES, (p) => p.owners * PER_MIN.page, (path) => `Agency console page ${path}, the whole agency's records`, (path) => `apps/console/app/(agency)${path}/page.tsx`, 800),
  { kind: 'owner_live', role: 'owner', method: 'GET', path: '/api/live', perMin: (p) => p.owners * PER_MIN.live, budget: 100,
    does: 'The 5-second poll, owner scope (every thread of the agency)', code: 'apps/console/app/api/live/route.ts, core/mail/live.ts' },
  { kind: 'owner_bell', role: 'owner', method: 'GET', path: '/api/notifications', perMin: (p) => p.owners * PER_MIN.bell, budget: 300,
    does: 'The bell, every minute', code: 'apps/console/app/api/notifications/route.ts' },

  // Platform admin
  ...pages('admin', ADMIN_PAGES, (p) => p.admins * PER_MIN.adminPage, (path) => `Admin page ${path}: reads across every agency; each view writes platform_view_log`, (path) => `apps/console/app/(admin)${path.replace('{agency}', '[agencyId]')}/page.tsx`, 2000),

  // Systems
  { kind: 'system_stripe_webhook', role: 'system', method: 'POST', path: '/api/stripe/webhook', perMin: () => 600, budget: 1000,
    does: 'A signed Stripe event of a type we do not handle: signature checked, answered 200, nothing stored', code: 'apps/web/app/api/stripe/webhook/route.ts' },
  { kind: 'system_health_web', role: 'system', method: 'GET', path: '/api/health', perMin: () => 60, budget: 300,
    does: 'Uptime monitor on the public site: database reachable, schema current', code: 'apps/web/app/api/health/route.ts' },
  { kind: 'system_health_console', role: 'system', method: 'GET', path: '/api/health', perMin: () => 60, budget: 300,
    does: 'Uptime monitor on the console', code: 'apps/console/app/api/health/route.ts' },
];

// Which server answers a role (console surfaces are picked by the host name).
export function baseUrl(role, kind, env) {
  if (role === 'agent') return env.AGENTS_URL || 'http://agents.lvh.me:3001';
  if (role === 'owner') return env.AGENCY_URL || 'http://agency.lvh.me:3001';
  if (role === 'admin') return env.ADMIN_URL || 'http://admin.lvh.me:3001';
  if (kind === 'system_health_console') return env.AGENTS_URL || 'http://agents.lvh.me:3001';
  return env.WEB || 'http://web.lvh.me:3000';
}

// The session pool a role signs in with (load/sessions.json), or none.
export const SESSION_OF = { buyer: 'buyer', agent: 'agent', owner: 'owner', admin: 'admin' };

// The URL path with its ids filled in, and the body a POST sends. `pick` chooses one item of a list.
export function fill(path, targets, pick) {
  return path
    .replace('{listing}', () => pick(targets.listings))
    .replace('{property}', () => pick(targets.properties))
    .replace('{suburb}', () => encodeURIComponent(pick(targets.suburbs)))
    .replace('{suburbPath}', () => pick(targets.suburbPaths))
    .replace('{agency}', () => pick(targets.agencies));
}

export function body(kind, targets, pick, id) {
  if (kind === 'visitor_beacon') {
    return JSON.stringify(Math.random() < 0.6
      ? { kind: 'listing_view', listingId: pick(targets.listings) }
      : { kind: 'search', query: { suburb: pick(targets.suburbs), channel: 'sale' } });
  }
  if (kind === 'buyer_ping') return JSON.stringify({ kind: 'ping' });
  // An event type the platform does not handle: signed, checked, answered 200, nothing stored.
  if (kind === 'system_stripe_webhook') return JSON.stringify({ id: `evt_load_${id}`, type: 'customer.created', data: { object: { id: 'cus_load' } } });
  return null;
}
