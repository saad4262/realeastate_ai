import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { aiBudgetCaps } from '../assistant/budget';
import { can, type Actor } from '../permissions';
import { PlatformError } from './admin';

/**
 * The admin console's AI cost page (ADR 0086): what `ai_run` says the platform's AI calls have cost, by
 * agency and by feature. `platform:read` only, and no agency sees it. Every total on the page is added up
 * here from one grouped statement, so the two tables cannot disagree. Two statements per read, none per row.
 *
 * The figures are worked out from token counts and our price list (`packages/ai/src/models.ts`), so the
 * providers' bills stay the final word. The limits are the ones the budget checks read (`aiBudgetCaps`).
 */

export const AI_COST_PERIODS = [1, 7, 30] as const;
export type AiCostPeriod = (typeof AI_COST_PERIODS)[number];

/** The URL's `days`. Anything else is the default. */
export function parseAiCostPeriod(raw: string | string[] | undefined): AiCostPeriod {
  const v = Number(Array.isArray(raw) ? raw[0] : raw);
  return AI_COST_PERIODS.find((p) => p === v) ?? 30;
}

/** From here a limit is shown as close. */
export const AI_COST_WARN_AT = 0.8;
export type CapState = 'ok' | 'near' | 'over';

/** `>=` as in `decideBudget`: at exactly the limit it is spent. */
export function capState(spent: number, cap: number): CapState {
  if (spent >= cap) return 'over';
  return spent >= cap * AI_COST_WARN_AT ? 'near' : 'ok';
}

type FeatureGroup = { label: string; public: boolean };

const CONSOLE = (label: string): FeatureGroup => ({ label, public: false });
const FEATURE_GROUPS: Readonly<Record<string, FeatureGroup>> = Object.freeze({
  assistant: CONSOLE('Console assistant'),
  'document-read': CONSOLE('Reading documents'),
  'inbox:summary': CONSOLE('Inbox summaries and replies'),
  'inbox:draft': CONSOLE('Inbox summaries and replies'),
  'skill:morning_brief': CONSOLE('Morning Brief, Important emails'),
  'skill:important_emails': CONSOLE('Morning Brief, Important emails'),
  'lead:understand': CONSOLE('Understanding enquiries, AI decides'),
  'workflow:decide': CONSOLE('Understanding enquiries, AI decides'),
  'workflow:draft_email': CONSOLE('Workflow email drafts'),
  'contact:summary': CONSOLE('Customer and property summaries'),
  'property:summary': CONSOLE('Customer and property summaries'),
  'import-map': CONSOLE('Contact import help'),
  'import-clean': CONSOLE('Contact import help'),
  ai_callback: CONSOLE('AI calls back (Retell)'),
  search_embedding: CONSOLE('Search indexing'),
  // These two carry the buyers' prefix but work on an agency's listing, not for a buyer.
  'consumer:floorplan_rooms': CONSOLE('Reading floorplans'),
  'consumer:visual_embed': CONSOLE('Indexing listing photos'),
  'property-chat': { label: 'Property chat (public)', public: true },
  'alert-summary': { label: 'Alert summaries', public: true },
});
const BUYER_TOOLS: FeatureGroup = { label: 'Buyer tools (research, due diligence and more)', public: true };

/** What the page calls a feature, and whether a call with no agency on it was for the public site. A new feature shows under its own key. */
export function aiFeatureGroup(feature: string): FeatureGroup {
  return FEATURE_GROUPS[feature] ?? (feature.startsWith('consumer:') ? BUYER_TOOLS : CONSOLE(feature));
}

/** "claude-sonnet-5-5" → "Sonnet 5.5". */
function modelLabel(model: string): string {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/.exec(model);
  if (m) return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}`;
  if (model === 'retell') return 'Retell';
  return model.startsWith('voyage') ? 'Voyage' : model;
}

export type AiCostWho = {
  key: string;
  kind: 'agency' | 'public' | 'unattributed';
  agencyId: string | null;
  name: string;
  spend: number;
  calls: number;
  /** The agency's assistant spend in the last 24 hours, against its limit. Null when there is no agency. */
  assistantDay: number | null;
  topFeature: string | null;
};

export type AiCostFeature = { label: string; features: string[]; model: string; spend: number; calls: number };

export type AiCostAttention =
  | { kind: 'platform'; spent: number; cap: number }
  | { kind: 'agency'; agencyId: string; name: string; spent: number; cap: number }
  | { kind: 'unpriced'; calls: number };

export type AiCostOverview = {
  period: AiCostPeriod;
  caps: { platform: number; person: number; agency: number };
  /** The same rolling 24 hours the limit reads. */
  daySpend: number;
  spend: number;
  calls: number;
  agencies: number;
  publicSpend: number;
  who: AiCostWho[];
  features: AiCostFeature[];
  attention: AiCostAttention[];
  /** One point per Sydney day, oldest first; the last is today so far. */
  days: { day: string; spend: number }[];
};

export type AiCostPerson = { key: string; name: string; role: string | null; spend: number; calls: number; assistantDay: number | null };

export type AiCostAgency = {
  period: AiCostPeriod;
  caps: { person: number; agency: number };
  assistantDay: number;
  spend: number;
  calls: number;
  shareOfPlatform: number;
  people: AiCostPerson[];
  features: AiCostFeature[];
};

const UUID = /^[0-9a-f-]{36}$/i;
const DAY_MS = 24 * 3_600_000;
const n = (v: unknown) => Number(v ?? 0);
const ASSISTANT = 'assistant';

function requireAdmin(admin: Actor): void {
  if (!can(admin, 'platform:read', { type: 'platform' })) {
    throw new PlatformError('forbidden', 'Only a platform admin may open the admin console');
  }
}

/**
 * Tokens spent and nothing charged: the model has no price in our list (`costUsd` answers 0). Voyage is left
 * out because a short search query really can round to nothing at six decimal places.
 */
const UNPRICED = sql`coalesce(r.cost_usd, 0) = 0 and coalesce(r.input_tokens, 0) + coalesce(r.output_tokens, 0) > 0 and r.model not like 'voyage%'`;

/** Fold a feature's rows into the page's lines, dearest first, each with the model that cost the most. */
function featureLines(rows: readonly { feature: string; model: string; spend: unknown; calls: unknown }[]): AiCostFeature[] {
  const lines = new Map<string, { features: Set<string>; models: Map<string, number>; spend: number; calls: number }>();
  for (const r of rows) {
    const { label } = aiFeatureGroup(r.feature);
    const line = lines.get(label) ?? { features: new Set<string>(), models: new Map<string, number>(), spend: 0, calls: 0 };
    line.features.add(r.feature);
    line.models.set(r.model, (line.models.get(r.model) ?? 0) + n(r.spend));
    line.spend += n(r.spend);
    line.calls += n(r.calls);
    lines.set(label, line);
  }
  return [...lines]
    .map(([label, l]) => ({
      label,
      features: [...l.features].sort(),
      model: modelLabel([...l.models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]),
      spend: l.spend,
      calls: l.calls,
    }))
    .sort((a, b) => b.spend - a.spend || a.label.localeCompare(b.label));
}

export type AiCostRow = {
  agency_id: string | null;
  agency_name: string | null;
  feature: string;
  model: string;
  spend: unknown;
  calls: unknown;
  day_spend: unknown;
  unpriced: unknown;
};

/** Everything the page says, from the grouped rows. Pure. */
export function foldAiCost(rows: readonly AiCostRow[], caps: AiCostOverview['caps']): Omit<AiCostOverview, 'period' | 'days'> {
  type Line = AiCostWho & { byFeature: Map<string, number> };
  const who = new Map<string, Line>();
  let daySpend = 0;
  let unpriced = 0;
  for (const r of rows) {
    const group = aiFeatureGroup(r.feature);
    const kind = r.agency_id ? 'agency' : group.public ? 'public' : 'unattributed';
    const key = r.agency_id ?? kind;
    const line =
      who.get(key) ??
      ({
        key,
        kind,
        agencyId: r.agency_id,
        name: r.agency_id ? (r.agency_name ?? 'Unnamed agency') : kind === 'public' ? 'Public site (buyers)' : 'Not tied to an agency',
        spend: 0,
        calls: 0,
        assistantDay: r.agency_id ? 0 : null,
        topFeature: null,
        byFeature: new Map<string, number>(),
      } satisfies Line);
    line.spend += n(r.spend);
    line.calls += n(r.calls);
    if (line.assistantDay !== null && r.feature === ASSISTANT) line.assistantDay += n(r.day_spend);
    line.byFeature.set(group.label, (line.byFeature.get(group.label) ?? 0) + n(r.spend));
    who.set(key, line);
    daySpend += n(r.day_spend);
    unpriced += n(r.unpriced);
  }

  const lines: AiCostWho[] = [...who.values()]
    .map(({ byFeature, ...line }) => ({
      ...line,
      topFeature: line.kind === 'agency' ? ([...byFeature].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null) : null,
    }))
    .sort((a, b) => b.spend - a.spend || a.key.localeCompare(b.key));

  const attention: AiCostAttention[] = [];
  if (capState(daySpend, caps.platform) !== 'ok') attention.push({ kind: 'platform', spent: daySpend, cap: caps.platform });
  for (const l of lines) {
    if (l.agencyId && l.assistantDay !== null && capState(l.assistantDay, caps.agency) !== 'ok') {
      attention.push({ kind: 'agency', agencyId: l.agencyId, name: l.name, spent: l.assistantDay, cap: caps.agency });
    }
  }
  if (unpriced > 0) attention.push({ kind: 'unpriced', calls: unpriced });

  return {
    caps,
    daySpend,
    spend: lines.reduce((s, l) => s + l.spend, 0),
    calls: lines.reduce((s, l) => s + l.calls, 0),
    agencies: lines.filter((l) => l.kind === 'agency').length,
    publicSpend: lines.find((l) => l.kind === 'public')?.spend ?? 0,
    who: lines,
    features: featureLines(rows),
    attention,
  };
}

const sydneyKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The last `count` Sydney days, oldest first, with a day nobody spent anything on at zero. Pure. */
export function aiCostDays(rows: readonly { day: string; spend: unknown }[], now: Date, count = 30): { day: string; spend: number }[] {
  const byDay = new Map(rows.map((r) => [r.day, n(r.spend)]));
  const [y, m, d] = sydneyKey.format(now).split('-').map(Number) as [number, number, number];
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.UTC(y, m - 1, d - (count - 1 - i))).toISOString().slice(0, 10);
    return { day, spend: byDay.get(day) ?? 0 };
  });
}

/** The whole platform for one period. Two statements, whatever the number of agencies. */
export async function aiCostOverview(db: Db, admin: Actor, opts: { period: AiCostPeriod; now?: Date; env?: NodeJS.ProcessEnv }): Promise<AiCostOverview> {
  requireAdmin(admin);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.period * DAY_MS).toISOString();
  const day = new Date(now.getTime() - DAY_MS).toISOString();
  // A day more than the chart shows: 30 Sydney days can start more than 30 × 24 hours ago.
  const chartFrom = new Date(now.getTime() - 31 * DAY_MS).toISOString();
  const [rows, daily] = await Promise.all([
    db.execute<AiCostRow>(sql`
      select r.agency_id, a.name as agency_name, r.feature, r.model,
        coalesce(sum(r.cost_usd), 0) as spend,
        count(*)::int as calls,
        coalesce(sum(r.cost_usd) filter (where r.created_at >= ${day}::timestamptz), 0) as day_spend,
        count(*) filter (where ${UNPRICED})::int as unpriced
      from ai_run r
      left join agency a on a.id = r.agency_id
      where r.created_at >= ${since}::timestamptz
      group by r.agency_id, a.name, r.feature, r.model`),
    db.execute<{ day: string; spend: unknown }>(sql`
      select to_char(r.created_at at time zone 'Australia/Sydney', 'YYYY-MM-DD') as day, coalesce(sum(r.cost_usd), 0) as spend
      from ai_run r
      where r.created_at >= ${chartFrom}::timestamptz
      group by 1`),
  ]);
  return { period: opts.period, days: aiCostDays([...daily], now), ...foldAiCost([...rows], aiBudgetCaps(opts.env)) };
}

/** One agency for one period, by person and by feature. Two statements. */
export async function aiCostForAgency(db: Db, admin: Actor, agencyId: string, opts: { period: AiCostPeriod; now?: Date; env?: NodeJS.ProcessEnv }): Promise<AiCostAgency> {
  requireAdmin(admin);
  if (!UUID.test(agencyId)) throw new PlatformError('not_found', 'That agency was not found');
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.period * DAY_MS).toISOString();
  const day = new Date(now.getTime() - DAY_MS).toISOString();
  const [rows, platform] = await Promise.all([
    db.execute<{ user_id: string | null; name: string | null; role: string | null; feature: string; model: string; spend: unknown; calls: unknown; day_spend: unknown }>(sql`
      select r.user_id, coalesce(nullif(u.name, ''), u.email) as name, m.role, r.feature, r.model,
        coalesce(sum(r.cost_usd), 0) as spend,
        count(*)::int as calls,
        coalesce(sum(r.cost_usd) filter (where r.created_at >= ${day}::timestamptz), 0) as day_spend
      from ai_run r
      left join "user" u on u.id = r.user_id
      left join membership m on m.user_id = r.user_id and m.agency_id = r.agency_id
      where r.agency_id = ${agencyId}::uuid and r.created_at >= ${since}::timestamptz
      group by r.user_id, u.name, u.email, m.role, r.feature, r.model`),
    db.execute<{ total: unknown }>(sql`select coalesce(sum(r.cost_usd), 0) as total from ai_run r where r.created_at >= ${since}::timestamptz`),
  ]);

  const people = new Map<string, AiCostPerson>();
  let spend = 0;
  let calls = 0;
  let assistantDay = 0;
  for (const r of rows) {
    const key = r.user_id ?? 'background';
    const person = people.get(key) ?? { key, name: r.user_id ? (r.name ?? 'Unnamed') : 'Background work', role: r.role, spend: 0, calls: 0, assistantDay: r.user_id ? 0 : null };
    person.spend += n(r.spend);
    person.calls += n(r.calls);
    const assistant = r.feature === ASSISTANT ? n(r.day_spend) : 0;
    if (person.assistantDay !== null) person.assistantDay += assistant;
    assistantDay += assistant;
    people.set(key, person);
    spend += n(r.spend);
    calls += n(r.calls);
  }
  const total = n(platform[0]?.total);
  const caps = aiBudgetCaps(opts.env);
  return {
    period: opts.period,
    caps: { person: caps.person, agency: caps.agency },
    assistantDay,
    spend,
    calls,
    shareOfPlatform: total > 0 ? spend / total : 0,
    people: [...people.values()].sort((a, b) => b.spend - a.spend || a.key.localeCompare(b.key)),
    features: featureLines([...rows]),
  };
}
