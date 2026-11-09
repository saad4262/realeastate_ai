import { and, count, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { aiRun, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { checkAiBudget } from '../schedules/budget';

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
const BULK_EMAIL = 'Send an approved email template to a saved list of contacts: prepare a batch, check every name, then Approve & Send. Consent and unsubscribes are respected. Needs Bulk email switched on in Skills. Your templates are listed on the same page, with a button to write a new one.';
const BULK_SMS = 'Text an SMS template to a saved list: check every name, then Approve & Send, from each contact’s agent’s number, in sending hours. Needs Bulk SMS on in Skills and a connected Twilio. Your templates are listed on the same page, with a button to write a new one.';
const SKILLS = 'Three tabs. Platform skills: every automatic feature, each with its own on/off switch, off until someone switches it on. AI skills: scheduled jobs such as Morning Brief. Automations: workflows, when something happens then do these steps.';
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

/** Pages with no sidebar line of their own. */
const HELP_EXTRAS: Readonly<Record<HelpSurface, readonly HelpExtra[]>> = Object.freeze({
  agency: [
    { href: '/settings/phone', label: 'Phone & SMS', where: 'Settings → Connectors', what: 'Connect the agency’s Twilio and give numbers to agents.' },
  ],
  agent: [
    { href: '/my-phone', label: 'My phone', where: 'Settings → Connectors', what: 'Your phone number: use one the agency gives you, or connect your own Twilio.' },
  ],
});

const pagesOf = (groups: readonly HelpNavGroup[]) => groups.flatMap((g) => g.items.filter((i) => !i.signOut).map((i) => ({ ...i, group: g.label })));

/** The guide for one console, built only from what that console's sidebar shows. The same text every time: it is a cached prefix. */
export function buildHelpGuide(surface: HelpSurface, groups: readonly HelpNavGroup[]): string {
  const lines = pagesOf(groups).map((p) => `- ${p.label} (${p.href}), in the sidebar${p.group ? ` under ${p.group}` : ''}: ${HELP_PAGES[p.href] ?? ''}`);
  const extras = HELP_EXTRAS[surface].map((e) => `- ${e.label} (${e.href}), reached from ${e.where}: ${e.what}`);
  return [...lines, ...extras].join('\n');
}

/** Every path the bot may link to in this console. */
export function helpHrefs(surface: HelpSurface, groups: readonly HelpNavGroup[]): ReadonlySet<string> {
  return new Set([...pagesOf(groups).map((p) => p.href), ...HELP_EXTRAS[surface].map((e) => e.href)]);
}

/** The guide's name for a path, by its longest matching page. Null for a page the guide does not have. */
export function helpPageName(path: string, surface: HelpSurface, groups: readonly HelpNavGroup[]): string | null {
  const clean = path.split(/[?#]/)[0]!;
  const all = [...pagesOf(groups), ...HELP_EXTRAS[surface]];
  const hit = all.filter((p) => clean === p.href || clean.startsWith(`${p.href}/`)).sort((a, b) => b.href.length - a.href.length)[0];
  return hit?.label ?? null;
}

export type HelpSegment = { text: string; href?: string };

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

export type HelpGate = { allowed: boolean; message: string | null };

/** May this person ask one more? Asked before the model is. The count is `ai_run`: no words are kept to count. */
export async function checkHelpAllowed(db: Db, actor: Actor, opts: { now?: Date; env?: NodeJS.ProcessEnv } = {}): Promise<HelpGate> {
  if (!actor.agencyId || !can(actor, 'help:ask', { type: 'help', agencyId: actor.agencyId })) return { allowed: false, message: 'Sign in to an agency to use help.' };
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const raw = Number(env.HELP_MESSAGES_PER_HOUR);
  const perHour = Number.isInteger(raw) && raw > 0 ? raw : HELP_LIMITS.perHour;
  const [[row], budget] = await Promise.all([
    db
      .select({ n: count() })
      .from(aiRun)
      .where(and(eq(aiRun.userId, actor.userId), eq(aiRun.feature, HELP_FEATURE), gte(aiRun.createdAt, new Date(now.getTime() - 3_600_000)))),
    checkAiBudget(db, { now, env }),
  ]);
  if ((row?.n ?? 0) >= perHour) return { allowed: false, message: 'That is a lot of questions for one hour. Try again a little later.' };
  if (!budget.allowed) return { allowed: false, message: 'Help is resting until tomorrow. The sidebar still has everything.' };
  return { allowed: true, message: null };
}
