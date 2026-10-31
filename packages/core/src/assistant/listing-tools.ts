import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { listing, property, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { createListing } from '../listings/create-listing';
import { updateListing } from '../listings/update-listing';
import { setListingStatus, SUBMITTABLE_FROM } from '../listings/publish-listing';
import { createListingInputSchema, formatAddress, propertyTypeLabel, updateListingInputSchema, type ListingForEdit } from '../listings/listing-schema';
import { resolvePin, type ResolvedPin } from '../listings/property-resolver';
import { listingScopeFilters } from '../listings/scope';
import { resolveHandle } from './handles';
import { propose, type FrozenArgs } from './actions';
import { AssistantError } from './conversations';
import { figuresIn, NOTHING_YET, refused, UNKNOWN_REF } from './write-tools';
import type { createListingDraftInput, ProposalCard, submitListingInput, updateListingInput, withdrawListingInput } from './schema';
import type { ToolContext, ToolOutcome } from './tools';
import { adFacts } from '../listings/facts';

/**
 * Listings by the assistant (ADR 0040 part 2 §4). Each tool only PROPOSES a card built from the
 * database; Approve runs the screens' own core functions — `createListing`, `updateListing`,
 * `setListingStatus` — as the person, which ask `listing:*` again. A new listing is always a
 * draft; the assistant never puts a listing on the public site (decided 2026-10-13). "Delete" is
 * withdraw (ADR 0039 A). No network call runs inside a card's claim: a new listing's address is
 * geocoded when its card is made, and the pin travels frozen on the card.
 */

const STATUS_WORDS: Record<string, string> = {
  draft: 'Draft — not on the public site',
  pending: 'Waiting for approval — not on the public site yet',
  live: 'Live — on the public site',
  under_offer: 'Under offer — on the public site',
  sold: 'Sold',
  leased: 'Leased',
  withdrawn: 'Withdrawn — off the public site',
};

const money = (n: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(n);
const WRITTEN_WITH_ASSISTANT =
  'Written with the assistant: read the headline, the description and every figure word for word — what you approve is what is saved. You can change any of it later on the edit page.';

/** The fields the assistant may change, the edit form's own — one name each, as the frozen card holds them. */
const EDITABLE = ['headline', 'description', 'priceDisplay', 'priceFrom', 'priceTo', 'rentPw', 'bedrooms', 'bathrooms', 'carSpaces', 'propertyType', 'landAreaSqm'] as const;
type Editable = (typeof EDITABLE)[number];
type Value = string | number | null;

const FIELD_LABELS: Record<Editable, string> = {
  headline: 'Headline',
  description: 'Description',
  priceDisplay: 'Price shown on the ad',
  priceFrom: 'Price range for search — from',
  priceTo: 'Price range for search — up to',
  rentPw: 'Rent per week',
  bedrooms: 'Bedrooms',
  bathrooms: 'Bathrooms',
  carSpaces: 'Car spaces',
  propertyType: 'Property type',
  landAreaSqm: 'Land area',
};

function shown(k: Editable, v: Value): string {
  if (v === null || v === '') return '(none)';
  if (k === 'priceFrom' || k === 'priceTo' || k === 'rentPw') return money(Number(v));
  if (k === 'landAreaSqm') return `${v} m²`;
  if (k === 'propertyType') return propertyTypeLabel(String(v));
  if (k === 'description') return String(v).length > 160 ? `${String(v).slice(0, 160)}… (in full below)` : String(v);
  return String(v);
}

/** A listing behind a P reference, among the ones this person works on (find_listings' own scope). */
async function visibleListing(ctx: ToolContext, ref: string) {
  const id = resolveHandle(ctx.handles, ref, 'listing');
  if (!id) return { error: UNKNOWN_REF } as const;
  const [row] = await ctx.db
    .select({ id: listing.id, agencyId: listing.agencyId, status: listing.status, unit: property.unit, streetNumber: property.streetNumber, street: property.street, suburb: property.suburb, state: property.state, postcode: property.postcode })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(and(eq(listing.id, id), ...listingScopeFilters(ctx.actor)))
    .limit(1);
  if (!row) return { error: 'That listing is not one this person works on.' } as const;
  return { row, address: formatAddress(row), resource: { type: 'listing', id: row.id, agencyId: row.agencyId } } as const;
}

// ── create_listing_draft ─────────────────────────────────────────────────────

/** A pin as frozen on a card (JSON), and back. */
export type FrozenPin = { latitude: string; longitude: string; placeId: string | null; formattedAddress: string | null; geocodedAt: string; geocodeSource: 'google' | 'manual' };
const freezePin = (p: ResolvedPin): FrozenPin | null => (p ? { ...p, geocodedAt: p.geocodedAt.toISOString() } : null);
const thawPin = (p: FrozenPin | null): ResolvedPin => (p ? { ...p, geocodedAt: new Date(p.geocodedAt) } : null);

export async function proposeCreateListingDraft(ctx: ToolContext, input: z.infer<typeof createListingDraftInput>, label: string): Promise<ToolOutcome> {
  const { actor, db } = ctx;
  if (!actor.agencyId || !can(actor, 'listing:create', { type: 'listing', agencyId: actor.agencyId })) {
    return refused('This person may not add listings.', label);
  }
  const draft = {
    property: {
      ...(input.unit ? { unit: input.unit } : {}),
      ...(input.street_number ? { streetNumber: input.street_number } : {}),
      ...(input.street ? { street: input.street } : {}),
      suburb: input.suburb,
      state: input.state,
      postcode: input.postcode,
      ...(input.property_type ? { propertyType: input.property_type } : {}),
      ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}),
      ...(input.bathrooms !== undefined ? { bathrooms: input.bathrooms } : {}),
      ...(input.car_spaces !== undefined ? { carSpaces: input.car_spaces } : {}),
      ...(input.land_area_sqm !== undefined ? { landAreaSqm: input.land_area_sqm } : {}),
    },
    listing: {
      channel: input.channel,
      headline: input.headline,
      ...(input.description ? { description: input.description } : {}),
      ...(input.price_display ? { priceDisplay: input.price_display } : {}),
      ...(input.price_low !== undefined ? { priceFrom: input.price_low } : {}),
      ...(input.price_high !== undefined ? { priceTo: input.price_high } : {}),
      ...(input.rent_per_week !== undefined ? { rentPw: input.rent_per_week } : {}),
    },
  };
  // The screen's own rules (a sale says something about price, a rental has a weekly rent…), before any card.
  const parsed = createListingInputSchema.safeParse({ ...draft, agentUserIds: [] });
  if (!parsed.success) return refused(`${parsed.error.issues[0]?.message ?? 'Those listing details are not valid'}. Ask the person; nothing was proposed.`, label);

  // The one network call, now — never inside the claim (CLAUDE.md). A geocoder outage is not a refusal.
  const pin = await resolvePin(db, parsed.data.property);
  const address = formatAddress(parsed.data.property);
  const l = parsed.data.listing;
  const p = parsed.data.property;
  const facts = [
    p.propertyType ? propertyTypeLabel(p.propertyType) : null,
    p.bedrooms !== undefined ? `${p.bedrooms} bed` : null,
    p.bathrooms !== undefined ? `${p.bathrooms} bath` : null,
    p.carSpaces !== undefined ? `${p.carSpaces} car` : null,
    p.landAreaSqm !== undefined ? `${p.landAreaSqm} m² land` : null,
  ].filter(Boolean);
  const range = l.priceFrom !== undefined || l.priceTo !== undefined
    ? [l.priceFrom !== undefined ? money(l.priceFrom) : null, l.priceTo !== undefined ? money(l.priceTo) : null].filter(Boolean).join(' – ')
    : 'Not given';
  const figures = [...new Set([...figuresIn(`${l.headline}\n${l.description ?? ''}\n${l.priceDisplay ?? ''}`), ...[l.priceFrom, l.priceTo, l.rentPw].filter((n): n is number => n !== undefined).map(money)])];

  const card: ProposalCard = {
    title: `Draft a listing: ${address}`,
    contact: { id: '', name: '' },
    lines: [
      { label: 'Address', value: address },
      { label: 'Map pin', value: pin ? `Found — ${pin.formattedAddress ?? address}` : 'Not found — set it on the listing’s edit page after it is saved' },
      { label: 'For', value: l.channel === 'rent' ? 'Lease' : 'Sale' },
      ...(facts.length ? [{ label: 'Property', value: facts.join(' · ') }] : []),
      { label: 'Headline', value: l.headline },
      ...(l.channel === 'rent'
        ? [{ label: 'Rent per week', value: l.rentPw !== undefined ? money(l.rentPw) : 'Not given' }]
        : [
            { label: 'Price shown on the ad', value: l.priceDisplay || '(none)' },
            { label: 'Price range for search', value: range },
          ]),
      { label: 'Status', value: 'Draft — not on the public site. An owner or admin publishes it from the listing’s page.' },
      { label: 'Agent', value: 'You' },
    ],
    ...(l.description ? { text: { label: 'Description', value: l.description } } : {}),
    ...(figures.length ? { figures } : {}),
    notes: [NOTHING_YET, WRITTEN_WITH_ASSISTANT, 'Photos are added on the edit page.'],
  };
  const args: FrozenArgs = { tool: 'create_listing_draft', draft, pin: freezePin(pin) };
  return propose(ctx, label, { tool: 'create_listing_draft', args, card, contactId: null });
}

// ── update_listing ───────────────────────────────────────────────────────────

type Editing = {
  status: string;
  property: { unit: string | null; streetNumber: string | null; street: string | null; suburb: string; state: string; postcode: string; propertyType: string | null; bedrooms: number | null; bathrooms: number | null; carSpaces: number | null; landAreaSqm: number | null; buildingAreaSqm: number | null; yearBuilt: number | null };
  listing: { channel: ListingForEdit['listing']['channel']; headline: string; description: string | null; priceDisplay: string | null; priceFrom: number | null; priceTo: number | null; rentPw: number | null };
  /** Not on the edit form: carried through unchanged, so an edit here never clears them. */
  auctionDate: string | null;
  availableFrom: string | null;
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * The listing as its edit form holds it (getListingForEdit's columns, numbers as numbers),
 * in this agency. No permission here: the card asks can() when it is made, and updateListing
 * asks listing:edit again when it runs. One statement.
 */
async function loadEditing(db: DbOrTx, agencyId: string, listingId: string): Promise<Editing | null> {
  const [r] = await db
    .select({
      status: listing.status,
      channel: listing.channel,
      headline: listing.headline,
      description: listing.description,
      priceDisplay: listing.priceDisplay,
      priceFrom: listing.priceFrom,
      priceTo: listing.priceTo,
      rentPw: listing.rentPw,
      auctionDate: listing.auctionDate,
      availableFrom: listing.availableFrom,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
      propertyType: adFacts.propertyType,
      bedrooms: adFacts.bedrooms,
      bathrooms: adFacts.bathrooms,
      carSpaces: adFacts.carSpaces,
      landAreaSqm: adFacts.landAreaSqm,
      buildingAreaSqm: adFacts.buildingAreaSqm,
      yearBuilt: adFacts.yearBuilt,
    })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(and(eq(listing.id, listingId), eq(listing.agencyId, agencyId)))
    .limit(1);
  if (!r) return null;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    status: r.status,
    property: {
      unit: r.unit,
      streetNumber: r.streetNumber,
      street: r.street,
      suburb: r.suburb,
      state: r.state,
      postcode: r.postcode,
      propertyType: r.propertyType,
      bedrooms: r.bedrooms,
      bathrooms: num(r.bathrooms),
      carSpaces: r.carSpaces,
      landAreaSqm: num(r.landAreaSqm),
      buildingAreaSqm: num(r.buildingAreaSqm),
      yearBuilt: r.yearBuilt,
    },
    listing: {
      channel: r.channel as Editing['listing']['channel'],
      headline: r.headline ?? '',
      description: r.description,
      priceDisplay: r.priceDisplay,
      priceFrom: num(r.priceFrom),
      priceTo: num(r.priceTo),
      rentPw: num(r.rentPw),
    },
    auctionDate: iso(r.auctionDate),
    availableFrom: iso(r.availableFrom),
  };
}

function currentValue(cur: Editing, k: Editable): Value {
  switch (k) {
    case 'headline':
    case 'description':
    case 'priceDisplay':
    case 'priceFrom':
    case 'priceTo':
    case 'rentPw':
      return (cur.listing[k] as Value) ?? null;
    default:
      return (cur.property[k] as Value) ?? null;
  }
}

/** The whole edit, as the form would send it: today's values, with only `patch` changed. Never the pin. */
function editInput(cur: Editing, patch: Partial<Record<Editable, Value>>) {
  const v = (k: Editable) => (k in patch ? patch[k]! : currentValue(cur, k));
  const opt = <T>(x: T | null | undefined | '') => (x === null || x === undefined || x === '' ? undefined : x);
  const p = cur.property;
  return {
    property: {
      unit: opt(p.unit),
      streetNumber: opt(p.streetNumber),
      street: opt(p.street),
      suburb: p.suburb,
      state: p.state,
      postcode: p.postcode,
      propertyType: opt(v('propertyType') as string | null),
      bedrooms: opt(v('bedrooms') as number | null),
      bathrooms: opt(v('bathrooms') as number | null),
      carSpaces: opt(v('carSpaces') as number | null),
      landAreaSqm: opt(v('landAreaSqm') as number | null),
      buildingAreaSqm: opt(p.buildingAreaSqm),
      yearBuilt: opt(p.yearBuilt),
    },
    listing: {
      channel: cur.listing.channel,
      headline: v('headline') as string,
      description: opt(v('description') as string | null),
      priceDisplay: opt(v('priceDisplay') as string | null),
      priceFrom: opt(v('priceFrom') as number | null),
      priceTo: opt(v('priceTo') as number | null),
      rentPw: opt(v('rentPw') as number | null),
      availableFrom: opt(cur.availableFrom),
      auctionDate: opt(cur.auctionDate),
    },
  };
}

export async function proposeUpdateListing(ctx: ToolContext, input: z.infer<typeof updateListingInput>, label: string): Promise<ToolOutcome> {
  const l = await visibleListing(ctx, input.listing);
  if ('error' in l) return refused(l.error!, label);
  if (!can(ctx.actor, 'listing:edit', l.resource)) return refused('Only an agent named on this listing, or an owner or admin, may change it.', label);
  const cur = await loadEditing(ctx.db, l.row.agencyId, l.row.id);
  if (!cur) return refused('That listing is not one this person works on.', label);

  const asked: Partial<Record<Editable, Value>> = {
    ...(input.headline !== undefined ? { headline: input.headline } : {}),
    ...(input.description !== undefined ? { description: input.description || null } : {}),
    ...(input.price_display !== undefined ? { priceDisplay: input.price_display || null } : {}),
    ...(input.price_low !== undefined ? { priceFrom: input.price_low } : {}),
    ...(input.price_high !== undefined ? { priceTo: input.price_high } : {}),
    ...(input.rent_per_week !== undefined ? { rentPw: input.rent_per_week } : {}),
    ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}),
    ...(input.bathrooms !== undefined ? { bathrooms: input.bathrooms } : {}),
    ...(input.car_spaces !== undefined ? { carSpaces: input.car_spaces } : {}),
    ...(input.property_type !== undefined ? { propertyType: input.property_type } : {}),
    ...(input.land_area_sqm !== undefined ? { landAreaSqm: input.land_area_sqm } : {}),
  };
  if (!Object.keys(asked).length) return refused('Say what to change: the headline, description, prices, rent, rooms, property type or land area.', label);
  const fields = (Object.keys(asked) as Editable[]).filter((k) => asked[k] !== currentValue(cur, k));
  if (!fields.length) return { label, result: { proposed: false, tell_the_user: 'The listing already says that, so nothing was proposed.' } };
  const patch = Object.fromEntries(fields.map((k) => [k, asked[k]!])) as Partial<Record<Editable, Value>>;
  const before = Object.fromEntries(fields.map((k) => [k, currentValue(cur, k)])) as Partial<Record<Editable, Value>>;

  // The edit form's own rules on the result (a sale keeps a price statement, from ≤ up to…), before any card.
  const check = updateListingInputSchema.safeParse(editInput(cur, patch));
  if (!check.success) return refused(`${check.error.issues[0]?.message ?? 'That change is not valid'}. Nothing was proposed.`, label);

  const text = fields.includes('description') && patch.description ? { label: 'New description', value: String(patch.description) } : undefined;
  const words = [patch.headline, patch.description, patch.priceDisplay].filter(Boolean).join('\n');
  const numbers = (['priceFrom', 'priceTo', 'rentPw'] as const).filter((k) => typeof patch[k] === 'number').map((k) => money(patch[k] as number));
  const figures = [...new Set([...figuresIn(words), ...numbers])];
  const isPublic = cur.status === 'live' || cur.status === 'under_offer';
  const card: ProposalCard = {
    title: `Change the listing at ${l.address}`,
    contact: { id: '', name: '' },
    lines: [
      { label: 'Listing', value: `${l.address} · ${STATUS_WORDS[cur.status] ?? cur.status}` },
      ...fields.map((k) => ({ label: FIELD_LABELS[k], value: `${shown(k, before[k] ?? null)} → ${shown(k, patch[k] ?? null)}` })),
    ],
    ...(text ? { text } : {}),
    ...(figures.length ? { figures } : {}),
    notes: [
      NOTHING_YET,
      ...(isPublic ? ['It is on the public site: buyers see the change as soon as you approve.'] : []),
      ...(words ? [WRITTEN_WITH_ASSISTANT] : []),
      'Only these fields change. The address, agents, photos and status stay as they are.',
    ],
  };
  const args: FrozenArgs = { tool: 'update_listing', listingId: l.row.id, patch, before };
  return propose(ctx, label, { tool: 'update_listing', args, card, contactId: null });
}

// ── withdraw_listing / submit_listing ────────────────────────────────────────

const WITHDRAWABLE = ['draft', 'pending', 'live', 'under_offer'];

export async function proposeWithdrawListing(ctx: ToolContext, input: z.infer<typeof withdrawListingInput>, label: string): Promise<ToolOutcome> {
  const l = await visibleListing(ctx, input.listing);
  if ('error' in l) return refused(l.error!, label);
  if (!can(ctx.actor, 'listing:edit', l.resource)) return refused('Only an agent named on this listing, or an owner or admin, may withdraw it.', label);
  if (l.row.status === 'withdrawn') return { label, result: { proposed: false, tell_the_user: 'That listing is already withdrawn.' } };
  if (!WITHDRAWABLE.includes(l.row.status)) {
    return refused('A sold or leased listing stays as it is — its result is part of the property’s history. Nothing was proposed.', label);
  }
  const card: ProposalCard = {
    title: `Withdraw the listing at ${l.address}`,
    contact: { id: '', name: '' },
    lines: [
      { label: 'Listing', value: l.address },
      { label: 'Now', value: STATUS_WORDS[l.row.status] ?? l.row.status },
      { label: 'After', value: STATUS_WORDS.withdrawn! },
    ],
    notes: [NOTHING_YET, 'Nothing is deleted: its enquiries, photos and history stay, and it can be submitted again later.'],
  };
  const args: FrozenArgs = { tool: 'withdraw_listing', listingId: l.row.id, before: l.row.status };
  return propose(ctx, label, { tool: 'withdraw_listing', args, card, contactId: null });
}

export async function proposeSubmitListing(ctx: ToolContext, input: z.infer<typeof submitListingInput>, label: string): Promise<ToolOutcome> {
  const l = await visibleListing(ctx, input.listing);
  if ('error' in l) return refused(l.error!, label);
  // Decided 2026-10-13: the assistant never puts a listing on the public site. Owners and admins publish on the page.
  if (can(ctx.actor, 'listing:publish', l.resource)) {
    return { label, result: { proposed: false, tell_the_user: 'You can publish it yourself on the listing’s page. The assistant never puts a listing on the public site.' } };
  }
  if (!can(ctx.actor, 'listing:submit', l.resource)) return refused('Only an agent named on this listing may send it for approval.', label);
  if (!(SUBMITTABLE_FROM as readonly string[]).includes(l.row.status)) {
    return {
      label,
      result: { proposed: false, tell_the_user: l.row.status === 'pending' ? 'That listing is already waiting for approval.' : 'Only a draft or withdrawn listing can be sent for approval.' },
    };
  }
  const card: ProposalCard = {
    title: `Send the listing at ${l.address} for approval`,
    contact: { id: '', name: '' },
    lines: [
      { label: 'Listing', value: l.address },
      { label: 'Now', value: STATUS_WORDS[l.row.status] ?? l.row.status },
      { label: 'After', value: 'Waiting for approval — an owner or admin reviews it and publishes it' },
    ],
    notes: [NOTHING_YET, 'It is not on the public site until an owner or admin publishes it.'],
  };
  const args: FrozenArgs = { tool: 'submit_listing', listingId: l.row.id, before: l.row.status };
  return propose(ctx, label, { tool: 'submit_listing', args, card, contactId: null });
}

// ── Running them (from actions.ts `execute`, inside the claim's savepoint) ──

const changedSince = (what: string) => new AssistantError('conflict', `The listing’s ${what} changed since this card was made, so nothing was changed. Ask again.`);

export async function runListingAction(
  tx: Db,
  actor: Actor,
  args: Extract<FrozenArgs, { tool: 'create_listing_draft' | 'update_listing' | 'withdraw_listing' | 'submit_listing' }>,
): Promise<{ result: Record<string, unknown> }> {
  switch (args.tool) {
    case 'create_listing_draft': {
      // listing:create again; always a draft, the approver its agent; the pin frozen on the card (no network here).
      const r = await createListing(tx, actor, { ...args.draft, agentUserIds: [] }, { pin: thawPin(args.pin) });
      return { result: { listingId: r.listingId } };
    }
    case 'update_listing': {
      const cur = await loadEditing(tx, actor.agencyId ?? '', args.listingId);
      if (!cur) throw new AssistantError('not_found', 'That listing no longer exists.');
      for (const k of Object.keys(args.before) as Editable[]) {
        if (currentValue(cur, k) !== (args.before[k] ?? null)) throw changedSince(FIELD_LABELS[k].toLowerCase());
      }
      // listing:edit again; the pin is never touched (`pin: null` with no coordinates leaves it as it is).
      await updateListing(tx, actor, args.listingId, editInput(cur, args.patch), { pin: null });
      return { result: { listingId: args.listingId, changed: Object.keys(args.patch) } };
    }
    case 'withdraw_listing':
    case 'submit_listing': {
      const [row] = await tx.select({ status: listing.status }).from(listing).where(eq(listing.id, args.listingId)).limit(1);
      if (!row) throw new AssistantError('not_found', 'That listing no longer exists.');
      if (row.status !== args.before) throw changedSince('status');
      // listing:edit / listing:submit again, and the submit guard in the write itself.
      const r = await setListingStatus(tx, actor, args.listingId, args.tool === 'withdraw_listing' ? 'withdrawn' : 'pending');
      return { result: { listingId: args.listingId, status: r.status } };
    }
  }
}

/**
 * The read-back (ADR 0040 §4) for the listing tools, inside the step's savepoint: the listing
 * now says what the card said it would. False means "could not be confirmed".
 */
export async function verifyListingAction(tx: DbOrTx, args: { tool: string } & Record<string, unknown>, result: Record<string, unknown>): Promise<boolean> {
  const id = String(result.listingId ?? '');
  if (!id) return false;
  const [row] = await tx.select({ agencyId: listing.agencyId, status: listing.status }).from(listing).where(eq(listing.id, id)).limit(1);
  if (!row) return false;
  if (args.tool === 'update_listing') {
    const cur = await loadEditing(tx, row.agencyId, id);
    const patch = args.patch as Partial<Record<Editable, Value>>;
    return Boolean(cur) && (Object.keys(patch) as Editable[]).every((k) => currentValue(cur!, k) === (patch[k] ?? null));
  }
  const want = args.tool === 'create_listing_draft' ? 'draft' : args.tool === 'withdraw_listing' ? 'withdrawn' : 'pending';
  return row.status === want;
}
