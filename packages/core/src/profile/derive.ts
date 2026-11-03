import { z } from 'zod';

/**
 * Personal Property AI's profile (ADR 0080, C4 decision 5), counted by code — never guessed by a model. Five fixed
 * fields about the HOME the buyer is looking for; there is no field about the buyer as a person, so no demographic
 * can be learnt or stored by construction. Every fact says where it came from, and the buyer's own edit wins.
 */

export const PROFILE_FIELDS = ['suburbs', 'channel', 'priceTo', 'bedrooms', 'propertyTypes'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** Where a fact came from: the buyer's own actions only. */
export type SourceKind = 'saved_search' | 'chat' | 'shortlist' | 'watch' | 'you';

/** A search filter the buyer used — in a saved search or in a chat with the guide. */
export type FilterSignal = { at: Date; suburb?: string; channel?: string; priceTo?: number; bedrooms?: number; propertyType?: string };
export type Signals = {
  savedSearches: readonly FilterSignal[];
  chats: readonly FilterSignal[];
  shortlisted: readonly { at: Date; suburb: string; channel: string; propertyType: string | null }[];
  watched: readonly { at: Date; suburb: string }[];
};

/** The buyer's edits: a value they set, or null — removed by them. A field not present is learnt. Strict: nothing else fits. */
export const profileOverridesSchema = z
  .object({
    suburbs: z.array(z.string().trim().min(1).max(60)).max(8).nullable().optional(),
    channel: z.enum(['sale', 'rent']).nullable().optional(),
    priceTo: z.number().int().positive().max(100_000_000).nullable().optional(),
    bedrooms: z.number().int().min(0).max(20).nullable().optional(),
    propertyTypes: z.array(z.string().trim().min(1).max(40)).max(5).nullable().optional(),
  })
  .strict();
export type ProfileOverrides = z.infer<typeof profileOverridesSchema>;

export type Fact<T> = { value: T; by: 'learnt' | 'you'; sources: { kind: SourceKind; count: number }[] };
export type ProfileFacts = {
  suburbs: Fact<string[]> | null;
  channel: Fact<'sale' | 'rent'> | null;
  priceTo: Fact<number> | null;
  bedrooms: Fact<number> | null;
  propertyTypes: Fact<string[]> | null;
};

const MAX_SUBURBS = 5;
const MAX_TYPES = 3;

const titleCase = (s: string) => s.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Count values with the kind each came from; most frequent first, ties by name. */
function tally(items: readonly { value: string; kind: SourceKind }[]): { value: string; count: number; kinds: Map<SourceKind, number> }[] {
  const by = new Map<string, { count: number; kinds: Map<SourceKind, number> }>();
  for (const i of items) {
    const key = titleCase(i.value);
    const row = by.get(key) ?? { count: 0, kinds: new Map() };
    row.count += 1;
    row.kinds.set(i.kind, (row.kinds.get(i.kind) ?? 0) + 1);
    by.set(key, row);
  }
  return [...by.entries()].map(([value, r]) => ({ value, ...r })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function sourcesOf(rows: readonly { kinds: Map<SourceKind, number> }[]): { kind: SourceKind; count: number }[] {
  const total = new Map<SourceKind, number>();
  for (const r of rows) for (const [k, n] of r.kinds) total.set(k, (total.get(k) ?? 0) + n);
  const order: SourceKind[] = ['saved_search', 'shortlist', 'watch', 'chat'];
  return order.filter((k) => total.has(k)).map((kind) => ({ kind, count: total.get(kind)! }));
}

/** The newest filter that set a field: saved searches first (a budget written down), then chats. */
function newest<K extends keyof FilterSignal>(signals: Signals, key: K): { value: NonNullable<FilterSignal[K]>; kind: SourceKind } | null {
  for (const [list, kind] of [[signals.savedSearches, 'saved_search'], [signals.chats, 'chat']] as const) {
    const hit = [...list].filter((s) => s[key] !== undefined && s[key] !== null).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    if (hit) return { value: hit[key] as NonNullable<FilterSignal[K]>, kind };
  }
  return null;
}

const filters = (s: Signals) => [...s.savedSearches.map((f) => ({ f, kind: 'saved_search' as const })), ...s.chats.map((f) => ({ f, kind: 'chat' as const }))];

/** The learnt profile, then the buyer's edits over it. Pure. */
export function deriveProfile(signals: Signals, overrides: ProfileOverrides = {}): ProfileFacts {
  const suburbRows = tally([
    ...filters(signals).flatMap(({ f, kind }) => (f.suburb ? [{ value: f.suburb, kind }] : [])),
    ...signals.shortlisted.map((l) => ({ value: l.suburb, kind: 'shortlist' as const })),
    ...signals.watched.map((w) => ({ value: w.suburb, kind: 'watch' as const })),
  ]).slice(0, MAX_SUBURBS);

  const channelRows = tally([
    ...filters(signals).flatMap(({ f, kind }) => (f.channel === 'sale' || f.channel === 'rent' ? [{ value: f.channel, kind }] : [])),
    ...signals.shortlisted.flatMap((l) => (l.channel === 'sale' || l.channel === 'rent' ? [{ value: l.channel, kind: 'shortlist' as const }] : [])),
  ]);
  // A tie says nothing: no fact rather than a coin toss.
  const channel = channelRows.length && (channelRows.length === 1 || channelRows[0]!.count > channelRows[1]!.count) ? channelRows[0]! : null;

  const price = newest(signals, 'priceTo');
  const bedRows = tally(filters(signals).flatMap(({ f, kind }) => (typeof f.bedrooms === 'number' ? [{ value: String(f.bedrooms), kind }] : [])));
  const typeRows = tally([
    ...filters(signals).flatMap(({ f, kind }) => (f.propertyType ? [{ value: f.propertyType, kind }] : [])),
    ...signals.shortlisted.flatMap((l) => (l.propertyType ? [{ value: l.propertyType, kind: 'shortlist' as const }] : [])),
  ]).slice(0, MAX_TYPES);

  const learnt: ProfileFacts = {
    suburbs: suburbRows.length ? { value: suburbRows.map((r) => r.value), by: 'learnt', sources: sourcesOf(suburbRows) } : null,
    channel: channel ? { value: channel.value.toLowerCase() as 'sale' | 'rent', by: 'learnt', sources: sourcesOf([channel]) } : null,
    priceTo: price ? { value: Number(price.value), by: 'learnt', sources: [{ kind: price.kind, count: 1 }] } : null,
    bedrooms: bedRows.length ? { value: Number(bedRows[0]!.value), by: 'learnt', sources: sourcesOf([bedRows[0]!]) } : null,
    propertyTypes: typeRows.length ? { value: typeRows.map((r) => r.value), by: 'learnt', sources: sourcesOf(typeRows) } : null,
  };

  const you = [{ kind: 'you' as const, count: 1 }];
  const out = { ...learnt } as ProfileFacts;
  for (const field of PROFILE_FIELDS) {
    if (!(field in overrides)) continue;
    const v = overrides[field];
    (out as Record<ProfileField, unknown>)[field] = v === null || v === undefined ? null : { value: v, by: 'you', sources: you };
  }
  return out;
}

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

/**
 * The one line the guide is handed (decision 5): what the buyer looks for, from their own activity. Every figure is
 * the stored value formatted here (#4). Null when nothing is known.
 */
export function profileLine(facts: ProfileFacts): string | null {
  const parts = [
    facts.suburbs ? `looks in ${facts.suburbs.value.join(', ')}` : null,
    facts.channel ? (facts.channel.value === 'rent' ? 'renting' : 'buying') : null,
    facts.priceTo ? `up to ${AUD.format(facts.priceTo.value)}${facts.channel?.value === 'rent' ? ' per week' : ''}` : null,
    facts.bedrooms ? `${facts.bedrooms.value}+ bedrooms` : null,
    facts.propertyTypes ? facts.propertyTypes.value.join(' or ').toLowerCase() : null,
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

/** "from 2 saved searches and 3 shortlisted homes" — for the page. Pure. */
export function sourceWords(sources: Fact<unknown>['sources']): string {
  const word: Record<SourceKind, [string, string]> = {
    saved_search: ['saved search', 'saved searches'],
    chat: ['chat with the guide', 'chats with the guide'],
    shortlist: ['shortlisted home', 'shortlisted homes'],
    watch: ['watched address', 'watched addresses'],
    you: ['', ''],
  };
  if (sources.some((s) => s.kind === 'you')) return 'set by you';
  const bits = sources.map((s) => `${s.count} ${word[s.kind][s.count === 1 ? 0 : 1]}`);
  return `from ${bits.length > 1 ? `${bits.slice(0, -1).join(', ')} and ${bits.at(-1)}` : bits[0]}`;
}
