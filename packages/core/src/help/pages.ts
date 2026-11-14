import { z } from 'zod';

/**
 * The console's help bot (ADR 0088): how to use the site, from a written guide and the page the person
 * is on. It has no tools and reads no records, and nothing said to it is saved. The model is told which
 * page by its name in the guide, never the URL, so an id in a URL does not reach it.
 */

export const HELP_FEATURE = 'help-bot';
export const HELP_LIMITS = { perHour: 30, messages: 12, chars: 1000, pathChars: 300 } as const;

export const helpRequestSchema = z
  .object({
    path: z.string().min(1).max(HELP_LIMITS.pathChars).regex(/^\//, 'A path starts with /'),
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).max(HELP_LIMITS.chars) }).strict())
      .min(1)
      .max(HELP_LIMITS.messages)
      .refine((m) => m[0]!.role === 'user' && m[m.length - 1]!.role === 'user', 'A conversation starts and ends with the person'),
  })
  .strict();
export type HelpRequest = z.infer<typeof helpRequestSchema>;

/** The sidebar, as the console's own data describes it. Passed in: core never reads apps/. */
export type HelpNavGroup = { label?: string; items: readonly { href: string; label: string; signOut?: true }[] };
export type HelpSurface = 'agency' | 'agent';

const FOLLOW_UPS = 'Say what you want in plain words and it finds the records; anything that changes something comes back as a card to approve.';
const BULK_EMAIL = 'Send an approved email template to a saved list of contacts: prepare a batch, check every name, then Approve & Send. Consent and unsubscribes are respected. Needs Email switched on in Skills. Your templates are listed on the same page, with a button to write a new one.';
const BULK_SMS = 'Text an SMS template to a saved list: check every name, then Approve & Send, from each contact’s agent’s number, in sending hours. Needs SMS on in Skills and a connected Twilio. Your templates are listed on the same page, with a button to write a new one.';
const SKILLS = 'Skills are the facilities the platform provides. Three tabs. Platform skills: each has its own on/off switch, off until someone switches it on; a skill that is on and has its own chat shows an Open chat link on its card. AI skills: ready-made jobs such as Morning Brief. Automations: everything you have set up with your skills, from their chats: what it does, which skill it came from, when it runs, whether it is on, an on/off button, its chat and its history. The top of the page has a button for the AI skills chat. Everyday work (notes, leads, appointments, contacts) is the AI Assistant’s, on the home page.';
const NOT_BUILT = 'A preview screen with placeholder content. It is not working yet.';

/** What each sidebar page is for. A page with no line here fails a test, so the guide cannot quietly fall behind the sidebar. */
export const HELP_PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/overview': `The home page: chat with the assistant. ${FOLLOW_UPS}`,
  '/assistant': `The home page: chat with the assistant. ${FOLLOW_UPS}`,
  '/ai': NOT_BUILT,
  '/leads': 'Enquiries and offers on the agency’s listings, with who each is assigned to.',
  '/my-leads': 'Enquiries on your listings and the ones assigned to you.',
  '/inbox': 'Email conversations with buyers, sellers and enquirers. Texts are one link away, at the top of the page.',
  '/my-inbox': 'Your email conversations with buyers, sellers and enquirers. Texts are one link away, at the top of the page.',
  '/missed-calls': 'Every agent’s missed calls. Open one to see it and follow up.',
  '/my-missed-calls': 'Your missed calls. Open one to see it and follow up.',
  '/calendar': 'Appointments for the agency.',
  '/my-calendar': 'Your appointments.',
  '/messages': 'Private messages between people in the agency.',
  '/my-messages': 'Private messages between people in the agency.',
  '/customers': 'Everyone the agency deals with. Add one, import a spreadsheet, or open a profile for its emails, texts, calls and activity.',
  '/my-contacts': 'The people you deal with. Add one, import a spreadsheet, or open a profile for its emails, texts, calls and activity.',
  '/team': 'The agency’s agents and staff: invite, change a role, or remove someone.',
  '/listing-activity': 'Who has been looking at the agency’s listings.',
  '/my-listing-activity': 'Who has been looking at the listings you are named on.',
  '/properties': 'Every address the agency has a record of, with everything on it.',
  '/my-properties': 'The addresses you have a record of, with everything on them.',
  '/live-listings': 'The agency’s listings: add, edit, and see each one’s status.',
  '/listings': 'Your listings: add, edit, and submit one for the agency to publish.',
  '/pipeline': 'Every sale from appraisal to settlement, stage by stage.',
  '/my-pipeline': 'Your sales from appraisal to settlement, stage by stage.',
  '/bulk-email': BULK_EMAIL,
  '/my-bulk-email': BULK_EMAIL,
  '/bulk-sms': BULK_SMS,
  '/my-bulk-sms': BULK_SMS,
  '/marketing': NOT_BUILT,
  '/my-reviews': 'The agency’s Google reviews.',
  '/control-centre': 'Everything the agency’s automations did by themselves: workflows, repeating sends, skills, missed calls and opportunities, with what failed. Owners and admins see every agent’s.',
  '/my-control-centre': 'Everything your automations did by themselves: workflows, repeating sends, skills, missed calls and opportunities, with what failed.',
  '/skills': SKILLS,
  '/my-skills': SKILLS,
  '/knowledge': 'The agency’s procedures and documents, which the assistant can answer from.',
  '/my-knowledge': 'The agency’s procedures and documents, which the assistant can answer from.',
  '/projects': 'Dashboards. Ask the assistant for one in words, then keep it open here.',
  '/my-projects': 'Dashboards. Ask the assistant for one in words, then keep it open here.',
  '/insights': NOT_BUILT,
  '/finance': 'Commission earned, expected and paid out. Trust accounting stays in the agency’s trust software.',
  '/my-commission': 'Your commission: earned, expected and paid out.',
  '/settings/integrations': 'Connect the agency’s accounts, such as Zoom, Google Reviews and Google Sheets. Phone & SMS is here too.',
  '/my-integrations': 'Connect your own accounts, such as Gmail and Zoom. My phone is here too.',
  '/settings': 'The agency’s settings. Connectors is the section that exists so far.',
});

type HelpExtra = { href: string; label: string; where: string; what: string };
type HelpDetail = { pattern: string; name: string; what: string };

/** Pages with no sidebar line of their own. */
const HELP_EXTRAS: Readonly<Record<HelpSurface, readonly HelpExtra[]>> = Object.freeze({
  agency: [{ href: '/settings/phone', label: 'Phone & SMS', where: 'Settings → Connectors', what: 'Connect the agency’s Twilio and give numbers to agents.' }],
  agent: [{ href: '/my-phone', label: 'My phone', where: 'Settings → Connectors', what: 'Verify your mobile, forward the calls you miss to your number, and text people from it. Use a number the agency gives you, or connect your own Twilio.' }],
});

type Paths = { people: string; listing: string; email: string; sms: string; inbox: string; projects: string; property: string; skills: string };

function sharedDetails(p: Paths): HelpDetail[] {
  return [
    { pattern: `${p.people}/[id]`, name: 'A customer’s profile', what: 'One person: their details, and tabs for their texts, calls, messages and activity.' },
    { pattern: `${p.people}/new`, name: 'New contact', what: 'Add one person.' },
    { pattern: `${p.people}/import`, name: 'Import contacts', what: 'Upload a CSV or Excel file, or pick a Google Sheet.' },
    { pattern: `${p.people}/import/[id]`, name: 'A contacts import', what: 'One import: check its rows and what failed.' },
    { pattern: `${p.listing}/new`, name: 'Add listing', what: 'Write a new listing.' },
    { pattern: `${p.listing}/[id]/edit`, name: 'Edit listing', what: 'One listing, in sections. Its status buttons are here too.' },
    { pattern: `${p.listing}/import`, name: 'Import listings', what: 'Upload a spreadsheet of listings.' },
    { pattern: `${p.listing}/import/[id]`, name: 'A listings import', what: 'One import: check its rows and what failed.' },
    { pattern: `${p.property}/[id]`, name: 'A property', what: 'One address and everything on record for it, in sections.' },
    { pattern: `${p.email}/[batchId]`, name: 'A bulk email batch', what: 'The frozen list of who gets it, a preview, and Approve & Send. A prepared batch expires after 48 hours.' },
    { pattern: `${p.email}/templates/new`, name: 'New email template', what: 'Write a template for bulk email.' },
    { pattern: `${p.email}/templates/[templateId]`, name: 'An email template', what: 'Change or retire one template.' },
    { pattern: `${p.sms}/[batchId]`, name: 'A bulk SMS batch', what: 'The list of who gets the text, and Approve & Send.' },
    { pattern: `${p.sms}/templates/new`, name: 'New SMS template', what: 'Write a template for bulk SMS.' },
    { pattern: `${p.sms}/templates/[templateId]`, name: 'An SMS template', what: 'Change or retire one template.' },
    { pattern: `${p.inbox}/new`, name: 'New email', what: 'Write an email to a contact.' },
    { pattern: `${p.inbox}/texts`, name: 'Texts', what: 'Text conversations.' },
    { pattern: `${p.projects}/[id]`, name: 'A dashboard', what: 'One dashboard, opened from Projects.' },
    { pattern: `${p.skills}/[id]`, name: 'An AI skill', what: 'One scheduled skill: its schedule, its instructions, on or off, Run now, and its past runs.' },
    { pattern: `${p.skills}/[id]/runs/[runId]`, name: 'A run of an AI skill', what: 'What one run of the skill found.' },
  ];
}

const ONBOARDING = 'A step in bringing a new agent into the agency.';

const HELP_DETAILS: Readonly<Record<HelpSurface, readonly HelpDetail[]>> = Object.freeze({
  agency: [
    ...sharedDetails({ people: '/customers', listing: '/live-listings', email: '/bulk-email', sms: '/bulk-sms', inbox: '/inbox', projects: '/projects', property: '/properties', skills: '/skills' }),
    { pattern: '/missed-calls/settings', name: 'Missed call settings', what: 'The greeting, the text and the daily limits.' },
    { pattern: '/settings/reviews', name: 'Google reviews', what: 'The agency’s public Google rating and reviews, shown on live listings’ pages.' },
    { pattern: '/skills/library/new', name: 'New library skill', what: 'Add a skill to the agency’s own library.' },
    { pattern: '/team/onboarding', name: 'Agent onboarding', what: ONBOARDING },
    { pattern: '/team/onboarding/dispatch', name: 'Agent onboarding: dispatch', what: ONBOARDING },
    { pattern: '/team/onboarding/governance', name: 'Agent onboarding: governance', what: ONBOARDING },
    { pattern: '/team/onboarding/permissions', name: 'Agent onboarding: permissions', what: ONBOARDING },
    { pattern: '/team/onboarding/review', name: 'Agent onboarding: review', what: ONBOARDING },
    { pattern: '/team/onboarding/territory', name: 'Agent onboarding: territory', what: ONBOARDING },
    { pattern: '/team/remove/[userId]', name: 'Remove an agent', what: 'Choose what happens to what they hold, then remove them.' },
    { pattern: '/team/removed', name: 'Removed agents', what: 'People removed from the agency, with Undo for 30 days.' },
  ],
  agent: [
    { pattern: '/assistant', name: 'Home', what: 'The home page: chat with the assistant.' },
    ...sharedDetails({ people: '/my-contacts', listing: '/listings', email: '/my-bulk-email', sms: '/my-bulk-sms', inbox: '/my-inbox', projects: '/my-projects', property: '/my-properties', skills: '/my-skills' }),
  ],
});

const SKILL_TABS_NAMED: Readonly<Record<string, string>> = Object.freeze({ platform: 'Platform skills', ai: 'AI skills', automations: 'Automations' });
const SKILLS_PAGES = new Set(['/skills', '/my-skills']);

const pagesOf = (groups: readonly HelpNavGroup[]) => groups.flatMap((g) => g.items.filter((i) => !i.signOut).map((i) => ({ ...i, group: g.label })));

function aroundEveryPage(): string {
  return `- The sidebar on the left has every page, in groups that open and close. Recents, at its top, lists your chats; a skill chat has its name on a small tag.
- The top bar: the search box; the Skills panel, which lists the ready-made skills that are on, with a switch for each; open one to see what has been set up with it and its chats; the Automations panel (the bolt icon), which shows only what is running or just ran: how far it has got, what failed in the last day, a Stop button, and how much of today's limits is used; the bell icon for notifications; New chat.
- The home chat is the AI Assistant: it looks things up and does everyday work (notes, leads, appointments, contacts, and the team for owners and admins), each change on a card you approve. For a skill's job, such as email, texts or listings, it shows a button that opens that skill's assistant.
- Each chat in Recents is labelled with its assistant, such as AI Assistant or Email Assistant.
- A skill chat does one job only, and has a blue bar at the top saying which. Open one from its card on Skills, while the skill is on.
- This help window sees which page you are on. It cannot see your records and cannot change anything.`;
}

function commonJobs(surface: HelpSurface): string {
  const people = surface === 'agency' ? 'Customers' : 'Contacts';
  const listing =
    surface === 'agency'
      ? '- Publish a listing: Properties → Listings → Add listing, fill it in, then Publish. Agents’ listings waiting for approval are on the same page. Under offer, Mark sold and Withdraw are on the listing.'
      : '- Add a listing: Properties → My Listings → Add listing, fill it in, then Submit for approval. The agency publishes it. Import from CSV is on the same page.';
  return `- Send a bulk email: first make a saved list: on ${people}, filter the list and press Save this filter. Switch on Email in Skills. On Marketing → Bulk email, under Prepare a send, pick a template and the saved list, press Prepare, check every name on the batch, then Approve & Send. Or open the Email chat from its card on Skills, which also drafts single emails and sets up email that repeats.
- Write an email template: Marketing → Bulk email → + New template.
- Send a bulk SMS: the same on Marketing → Bulk SMS: Prepare texts, check every name, Approve & Send. It needs SMS on in Skills, and a connected Twilio. The SMS chat, from its card on Skills, sends and sets up texts that repeat. Write one with + New SMS template.
- Add a person: People → ${people} → New contact. Import brings in a spreadsheet.
${listing}
- Book an appointment: Daily work → Calendar → + Schedule. + Team meeting books colleagues.
- Message a colleague: Daily work → Team messages → New message.
- Switch a skill on or off: Automation → Skills, Platform skills tab, the switch on its card.
- Set up an automation: open a skill's chat from its card on Skills and say what you want and when, for example a bulk email or a text every Monday. You approve one card and it runs by itself. It then shows on the Automations tab of Skills, where you can turn it on or off. Click one to see everything about it: the run going now, how many have gone and how many are left, and its history. One you made in a chat opens that chat, with the details beside it.
- Get a dashboard: Knowledge & insights → Projects → New with the assistant. It needs Dashboards on in Skills.
- Add a document for the assistant: Knowledge & insights → Knowledge base → Add documents.
- Connect Gmail, Zoom and other accounts: Settings → Connectors. Search finds one.${surface === 'agency' ? '\n- Add or remove an agent: People → Agents & Team.' : ''}`;
}

/** The guide for one console, from what that console shows. The same text every time: it is a cached prefix. */
export function buildHelpGuide(surface: HelpSurface, groups: readonly HelpNavGroup[]): string {
  const lines = pagesOf(groups).map((p) => `- ${p.label} (${p.href}), in the sidebar${p.group ? ` under ${p.group}` : ''}: ${HELP_PAGES[p.href] ?? ''}`);
  const extras = HELP_EXTRAS[surface].map((e) => `- ${e.label} (${e.href}), reached from ${e.where}: ${e.what}`);
  const details = HELP_DETAILS[surface].map((d) => `- ${d.name}${d.pattern.includes('[') ? '' : ` (${d.pattern})`}: ${d.what}`);
  return `Pages:\n${[...lines, ...extras].join('\n')}\n\nPages you reach from those:\n${details.join('\n')}\n\nOn every page:\n${aroundEveryPage()}\n\nHow to do common things:\n${commonJobs(surface)}`;
}

/** Every path the bot may link to in this console. A page with an id in it has no link of its own. */
export function helpHrefs(surface: HelpSurface, groups: readonly HelpNavGroup[]): ReadonlySet<string> {
  return new Set([...pagesOf(groups).map((p) => p.href), ...HELP_EXTRAS[surface].map((e) => e.href), ...HELP_DETAILS[surface].filter((d) => !d.pattern.includes('[')).map((d) => d.pattern)]);
}

export type HelpPageContext = { pattern: string; name: string; what: string; tab: string | null };

function knownPages(surface: HelpSurface, groups: readonly HelpNavGroup[]): HelpDetail[] {
  return [
    ...pagesOf(groups).map((p) => ({ pattern: p.href, name: p.label, what: HELP_PAGES[p.href] ?? '' })),
    ...HELP_EXTRAS[surface].map((e) => ({ pattern: e.href, name: e.label, what: e.what })),
    ...HELP_DETAILS[surface],
  ];
}

const staticSegments = (pattern: string) => pattern.split('/').filter((x) => x && !x.startsWith('[')).length;

function matchesExactly(pattern: string, path: string): boolean {
  const body = pattern.split('/').map((x) => (x.startsWith('[') ? '[^/]+' : x.replace(/[.*+?^${}()|\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${body}$`).test(path);
}

/**
 * The page, in the guide's own words. Every word is the guide's: an id in the URL, or anything else in it,
 * never reaches the model. A page's own line first, else the section it is under.
 */
export function helpPageContext(path: string, surface: HelpSurface, groups: readonly HelpNavGroup[]): HelpPageContext | null {
  const [raw, query = ''] = path.split('#')[0]!.split('?');
  const clean = raw!.length > 1 ? raw!.replace(/\/$/, '') : raw!;
  const all = knownPages(surface, groups);
  const hit =
    all.filter((p) => matchesExactly(p.pattern, clean)).sort((a, b) => staticSegments(b.pattern) - staticSegments(a.pattern))[0] ??
    all.filter((p) => !p.pattern.includes('[') && clean.startsWith(`${p.pattern}/`)).sort((a, b) => b.pattern.length - a.pattern.length)[0];
  if (!hit) return null;
  const tab = SKILLS_PAGES.has(hit.pattern) ? (SKILL_TABS_NAMED[new URLSearchParams(query).get('tab') ?? ''] ?? null) : null;
  return { pattern: hit.pattern, name: hit.name, what: hit.what, tab };
}

/** The guide's name for a path. Null for a page the guide does not have. */
export function helpPageName(path: string, surface: HelpSurface, groups: readonly HelpNavGroup[]): string | null {
  return helpPageContext(path, surface, groups)?.name ?? null;
}

export type HelpSegment = { text: string; href?: string };

/** The pages a reply really links to, for the browser, which is not given the whole list. */
export function helpReplyLinks(text: string, allowed: ReadonlySet<string>): string[] {
  return [...new Set(parseHelpReply(text, allowed).flatMap((s) => (s.href ? [s.href] : [])))];
}

/** `[Skills](/skills)` becomes a link when the guide has that page; any other link is left as its words. */
export function parseHelpReply(text: string, allowed: ReadonlySet<string>): HelpSegment[] {
  const out: HelpSegment[] = [];
  const link = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (const m of text.matchAll(link)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    const label = m[1]!;
    out.push(allowed.has(m[2]!) ? { text: label, href: m[2]! } : { text: label });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
