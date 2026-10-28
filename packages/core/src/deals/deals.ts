import { and, eq, sql, type SQL } from 'drizzle-orm';
import { contactRole, deal, dealCondition, dealEvent, type Db, type DbOrTx } from '@repo/db';
import { can, isAgencyAdminRole, type Actor } from '../permissions';
import { visibleContactIdsSql } from '../contacts/visibility';
import { listingPriceWords } from '../template-email/listing-values';
import { addConditionSchema, dealDetailsSchema, moveStageSchema, settleSchema, updateConditionSchema, type DealDetailsInput, type SettleInput } from './deal-schema';
import { DEAL_STAGE_LABELS, stageIndex, type DealStage, type DealStatus } from './stages';
import { DealError } from './errors';
import { amountsFrom, COMMISSION_COLUMNS, COMMISSION_JOINS, commissionState, type CommissionAmounts, type CommissionState } from './commission';

export { DealError };

/**
 * The deal pipeline's reads and writes (ADR 0063). Who may see a deal: owners and admins, every deal of the
 * agency; anyone else, deals whose listing names them or that are theirs. Who may change one: whoever may
 * edit its listing (`listing:edit`), or for an appraisal deal with no listing yet, its agent or an admin.
 * Every change is recorded on the deal's history.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

function seesAll(actor: Actor): boolean {
  return Boolean(actor.agencyId) && can(actor, 'listing:read_all', { type: 'listing', agencyId: actor.agencyId as string });
}

/** The deals this person may see, as a WHERE over `d`. Shared with the property page (ADR 0065). */
export function visibleDealsSql(actor: Actor): SQL {
  const agencyId = actor.agencyId as string;
  if (seesAll(actor)) return sql`d.agency_id = ${agencyId}`;
  return sql`d.agency_id = ${agencyId} and (d.agent_id = ${actor.userId} or exists (select 1 from listing_agent la where la.listing_id = d.listing_id and la.user_id = ${actor.userId}))`;
}

const ADDRESS = sql`concat_ws(', ', nullif(trim(concat(case when p.unit is not null then p.unit || '/' end, concat_ws(' ', p.street_number, p.street))), ''), p.suburb)`;

function initials(name: string | null): string {
  return (name ?? '?').trim().split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
}
const num = (v: string | number | null) => (v === null ? null : Number(v));

export type BoardDeal = {
  id: string;
  stage: DealStage;
  listingId: string | null;
  /** For a deal with no listing yet: its card opens the property's page (ADR 0065). */
  propertyId: string;
  vendorContactId: string | null;
  address: string;
  agentName: string | null;
  agentInitials: string;
  /** The sale price once known, else the listing's own price wording. */
  priceText: string | null;
  settlementDate: string | null;
  /** The earliest condition not yet met that has a date. */
  nextDue: { label: string; dueOn: string } | null;
  /** Owners and admins only (`lead:read_offer`); 0 for anyone else, who is never told an offer exists. */
  offers: number;
  /** Days since the deal last moved or changed. */
  quietDays: number;
};
export type BoardCounts = { active: number; underContract: number; settlingIn30: number; dueThisWeek: number };

/** The Pipeline board: open deals this person may see, one statement, with the board's four counts worked out from it. */
export async function listDeals(db: DbOrTx, actor: Actor, opts: { mine?: boolean; now?: Date } = {}): Promise<{ deals: BoardDeal[]; counts: BoardCounts }> {
  if (!actor.agencyId || !can(actor, 'listing:read', { type: 'listing', agencyId: actor.agencyId })) throw new DealError('forbidden', 'You do not have access to the pipeline.');
  const now = opts.now ?? new Date();
  const maySeeOffers = can(actor, 'lead:read_offer', { type: 'lead', agencyId: actor.agencyId });
  const mine = opts.mine ? sql`and (d.agent_id = ${actor.userId} or exists (select 1 from listing_agent la where la.listing_id = d.listing_id and la.user_id = ${actor.userId}))` : sql``;
  const rows = await db.execute<{
    id: string; stage: DealStage; listing_id: string | null; property_id: string; vendor_contact_id: string | null; address: string; agent_name: string | null;
    sale_price: string | null; channel: string | null; price_display: string | null; price_from: string | null; price_to: string | null; rent_pw: string | null;
    settlement_date: string | null; due_label: string | null; due_on: string | null; offers: number; updated_at: string;
  }>(sql`
    select d.id, d.stage, d.listing_id, d.property_id, d.vendor_contact_id, ${ADDRESS} as address, coalesce(u.name, u.email) as agent_name,
      d.sale_price::text, li.channel::text as channel, li.price_display, li.price_from::text, li.price_to::text, li.rent_pw::text,
      d.settlement_date::text, nd.label as due_label, nd.due_on::text, coalesce(o.n, 0)::int as offers, d.updated_at
    from deal d
    join property p on p.id = d.property_id
    left join listing li on li.id = d.listing_id
    left join "user" u on u.id = d.agent_id
    left join lateral (select c.label, c.due_on from deal_condition c where c.deal_id = d.id and c.done_at is null and c.due_on is not null order by c.due_on limit 1) nd on true
    left join lateral (select count(*) as n from lead l where l.listing_id = d.listing_id and l.kind = 'offer') o on d.listing_id is not null
    where d.status = 'open' and ${visibleDealsSql(actor)} ${mine}
    order by array_position(array['appraisal','listing','marketing','offers','negotiation','contract','settlement'], d.stage::text), d.updated_at desc
    limit 500`);
  const today = now.toISOString().slice(0, 10);
  const inDays = (n: number) => new Date(now.getTime() + n * DAY_MS).toISOString().slice(0, 10);
  const deals: BoardDeal[] = rows.map((r) => ({
    id: r.id,
    stage: r.stage,
    listingId: r.listing_id,
    propertyId: r.property_id,
    vendorContactId: r.vendor_contact_id,
    address: r.address,
    agentName: r.agent_name,
    agentInitials: initials(r.agent_name),
    priceText: r.sale_price
      ? listingPriceWords({ channel: 'sale', priceDisplay: null, priceFrom: num(r.sale_price), priceTo: null, rentPw: null })
      : r.channel
        ? listingPriceWords({ channel: r.channel, priceDisplay: r.price_display, priceFrom: num(r.price_from), priceTo: num(r.price_to), rentPw: num(r.rent_pw) })
        : null,
    settlementDate: r.settlement_date,
    nextDue: r.due_label && r.due_on ? { label: r.due_label, dueOn: r.due_on } : null,
    offers: maySeeOffers ? Number(r.offers) : 0,
    quietDays: Math.max(0, Math.floor((now.getTime() - new Date(r.updated_at).getTime()) / DAY_MS)),
  }));
  return {
    deals,
    counts: {
      active: deals.length,
      underContract: deals.filter((d) => d.stage === 'contract' || d.stage === 'settlement').length,
      settlingIn30: deals.filter((d) => d.settlementDate && d.settlementDate >= today && d.settlementDate <= inDays(30)).length,
      dueThisWeek: deals.filter((d) => d.nextDue && d.nextDue.dueOn <= inDays(7)).length,
    },
  };
}

export type DealView = {
  id: string;
  stage: DealStage;
  status: DealStatus;
  listingId: string | null;
  address: string;
  agentName: string | null;
  salePrice: number | null;
  buyer: { id: string; name: string } | null;
  vendor: { id: string; name: string } | null;
  contractDate: string | null;
  depositAmount: number | null;
  depositPaidOn: string | null;
  settlementDate: string | null;
  buyerSolicitor: string | null;
  settledAt: Date | null;
  conditions: { id: string; kind: string; label: string; dueOn: string | null; doneAt: Date | null }[];
  events: { kind: string; from: DealStage | null; to: DealStage | null; auto: boolean; actorName: string | null; note: string | null; at: Date }[];
  mayEdit: boolean;
  /** ADR 0064: what the agency set, and the amounts COMMISSION_SQL works out. */
  commission: CommissionAmounts & {
    basis: 'percent' | 'fixed' | null;
    rate: number | null;
    fixed: number | null;
    paidOn: string | null;
    state: CommissionState;
    /** Owners and admins (`deal:commission`). */
    mayEdit: boolean;
  };
};

type Head = { id: string; agency_id: string; listing_id: string | null; agent_id: string | null; stage: DealStage; status: DealStatus };

function mayEditDeal(actor: Actor, d: Pick<Head, 'agency_id' | 'listing_id' | 'agent_id'>): boolean {
  if (!actor.agencyId || actor.agencyId !== d.agency_id) return false;
  if (d.listing_id) return can(actor, 'listing:edit', { type: 'listing', id: d.listing_id, agencyId: d.agency_id });
  return isAgencyAdminRole(actor.membershipRole) || (d.agent_id === actor.userId && can(actor, 'listing:create', { type: 'listing', agencyId: d.agency_id }));
}

/** The Deal tab: the listing's open deal, else its latest one; null when it has none. */
export async function getDealForListing(db: DbOrTx, actor: Actor, listingId: string): Promise<DealView | null> {
  if (!actor.agencyId || !UUID.test(listingId) || !can(actor, 'listing:read', { type: 'listing', id: listingId, agencyId: actor.agencyId })) {
    throw new DealError('forbidden', 'You do not have access to this listing.');
  }
  const [d] = await db.execute<Head & {
    address: string; agent_name: string | null; sale_price: string | null; buyer_id: string | null; buyer_name: string | null; vendor_id: string | null; vendor_name: string | null;
    contract_date: string | null; deposit_amount: string | null; deposit_paid_on: string | null; settlement_date: string | null; buyer_solicitor: string | null; settled_at: string | null;
    commission_basis: 'percent' | 'fixed' | null; commission_rate: string | null; commission_fixed: string | null; paid_on: string | null;
    commission: string | null; split: string | null; split_from_profile: boolean; agent_share: string | null; agency_share: string | null; gst: string | null;
  }>(sql`
    select d.id, d.agency_id, d.listing_id, d.agent_id, d.stage, d.status, ${ADDRESS} as address, coalesce(u.name, u.email) as agent_name,
      d.sale_price::text, b.id as buyer_id, b.name as buyer_name, v.id as vendor_id, v.name as vendor_name,
      d.contract_date::text, d.deposit_amount::text, d.deposit_paid_on::text, d.settlement_date::text, d.buyer_solicitor, d.settled_at,
      d.commission_basis, d.commission_rate::text, d.commission_fixed::text, d.commission_paid_on::text as paid_on, ${COMMISSION_COLUMNS}
    from deal d join property p on p.id = d.property_id
    left join "user" u on u.id = d.agent_id
    left join contact b on b.id = d.buyer_contact_id
    left join contact v on v.id = d.vendor_contact_id
    ${COMMISSION_JOINS}
    where d.listing_id = ${listingId} and d.agency_id = ${actor.agencyId}
    order by (d.status = 'open') desc, d.created_at desc
    limit 1`);
  if (!d) return null;
  const [conditions, events] = await Promise.all([
    db.select().from(dealCondition).where(eq(dealCondition.dealId, d.id)).orderBy(dealCondition.sort, dealCondition.createdAt),
    db.execute<{ kind: string; from_stage: DealStage | null; to_stage: DealStage | null; auto: boolean; actor_name: string | null; note: string | null; created_at: string }>(sql`
      select e.kind, e.from_stage, e.to_stage, e.auto, coalesce(u.name, u.email) as actor_name, e.note, e.created_at
      from deal_event e left join "user" u on u.id = e.actor_id where e.deal_id = ${d.id} order by e.created_at desc limit 50`),
  ]);
  return {
    id: d.id,
    stage: d.stage,
    status: d.status,
    listingId: d.listing_id,
    address: d.address,
    agentName: d.agent_name,
    salePrice: num(d.sale_price),
    buyer: d.buyer_id ? { id: d.buyer_id, name: d.buyer_name ?? '' } : null,
    vendor: d.vendor_id ? { id: d.vendor_id, name: d.vendor_name ?? '' } : null,
    contractDate: d.contract_date,
    depositAmount: num(d.deposit_amount),
    depositPaidOn: d.deposit_paid_on,
    settlementDate: d.settlement_date,
    buyerSolicitor: d.buyer_solicitor,
    settledAt: d.settled_at ? new Date(d.settled_at) : null,
    conditions: conditions.map((c) => ({ id: c.id, kind: c.kind, label: c.label, dueOn: c.dueOn, doneAt: c.doneAt })),
    events: events.map((e) => ({ kind: e.kind, from: e.from_stage, to: e.to_stage, auto: e.auto, actorName: e.actor_name, note: e.note, at: new Date(e.created_at) })),
    mayEdit: d.status === 'open' && mayEditDeal(actor, d),
    commission: (() => {
      const a = amountsFrom(d);
      return {
        ...a,
        basis: d.commission_basis,
        rate: num(d.commission_rate),
        fixed: num(d.commission_fixed),
        paidOn: d.paid_on,
        state: commissionState({ status: d.status, stage: d.stage, commission: a.commission, paidOn: d.paid_on }),
        mayEdit: d.status !== 'withdrawn' && can(actor, 'deal:commission', { type: 'deal', agencyId: d.agency_id }),
      };
    })(),
  };
}

/** The open deal, if this person may change it. */
async function loadForWrite(db: DbOrTx, actor: Actor, dealId: string): Promise<Head> {
  if (!actor.agencyId || !UUID.test(dealId)) throw new DealError('not_found', 'That deal was not found.');
  const [d] = await db.execute<Head>(sql`select id, agency_id, listing_id, agent_id, stage, status from deal where id = ${dealId} and agency_id = ${actor.agencyId}`);
  if (!d) throw new DealError('not_found', 'That deal was not found.');
  if (!mayEditDeal(actor, d)) throw new DealError('forbidden', 'Only the listing’s agent or an owner or admin can change this deal.');
  if (d.status !== 'open') throw new DealError('conflict', 'This deal is closed.');
  return d;
}

async function record(db: DbOrTx, actor: Actor, d: Head, e: { kind: string; from?: DealStage | null; to?: DealStage | null; note?: string }) {
  await db.insert(dealEvent).values({ dealId: d.id, agencyId: d.agency_id, kind: e.kind, fromStage: e.from ?? null, toStage: e.to ?? null, auto: false, actorId: actor.userId, note: e.note ?? null });
}

/** A contact this person may read, in this agency — never an id from elsewhere. */
async function readableContact(db: DbOrTx, actor: Actor, id: string): Promise<boolean> {
  const [r] = await db.execute<{ ok: number }>(sql`select 1 as ok from contact c where c.id = ${id} and c.agency_id = ${actor.agencyId} and c.merged_into_id is null and c.id in (${visibleContactIdsSql(actor)})`);
  return Boolean(r);
}

const money = (v: number | null | undefined) => (v === null || v === undefined ? null : String(v));

export async function updateDealDetails(db: Db, actor: Actor, dealId: string, input: DealDetailsInput): Promise<void> {
  const patch = dealDetailsSchema.parse(input);
  const d = await loadForWrite(db, actor, dealId);
  if (patch.buyerContactId && !(await readableContact(db, actor, patch.buyerContactId))) throw new DealError('invalid', 'That buyer was not found among your contacts.');
  const set: Record<string, unknown> = {};
  if (patch.salePrice !== undefined) set.salePrice = money(patch.salePrice);
  if (patch.buyerContactId !== undefined) set.buyerContactId = patch.buyerContactId;
  if (patch.contractDate !== undefined) set.contractDate = patch.contractDate;
  if (patch.depositAmount !== undefined) set.depositAmount = money(patch.depositAmount);
  if (patch.depositPaidOn !== undefined) set.depositPaidOn = patch.depositPaidOn;
  if (patch.settlementDate !== undefined) set.settlementDate = patch.settlementDate;
  if (patch.buyerSolicitor !== undefined) set.buyerSolicitor = patch.buyerSolicitor || null;
  if (!Object.keys(set).length) return;
  await db.transaction(async (tx) => {
    await tx.update(deal).set({ ...set, updatedAt: sql`now()` }).where(eq(deal.id, d.id));
    await record(tx, actor, d, { kind: 'edited', note: 'Sale details changed' });
  });
}

/** A person may move a deal either way (the sync only ever moves forward). */
export async function moveDealStage(db: Db, actor: Actor, dealId: string, to: DealStage): Promise<void> {
  moveStageSchema.parse({ to });
  const d = await loadForWrite(db, actor, dealId);
  if (d.stage === to) return;
  await db.transaction(async (tx) => {
    await tx.update(deal).set({ stage: to, updatedAt: sql`now()` }).where(and(eq(deal.id, d.id), eq(deal.status, 'open')));
    await record(tx, actor, d, { kind: 'stage', from: d.stage, to, note: `Moved to ${DEAL_STAGE_LABELS[to]}` });
  });
}

/** Settle: the deal closes with its date and final price; optionally the buyer and vendor become Past clients (ADR 0061). */
export async function settleDeal(db: Db, actor: Actor, dealId: string, input: SettleInput): Promise<{ tagged: number }> {
  const s = settleSchema.parse(input);
  const d = await loadForWrite(db, actor, dealId);
  if (stageIndex(d.stage) < stageIndex('contract')) throw new DealError('conflict', 'Only a deal under contract can settle.');
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(deal)
      .set({ status: 'settled', stage: 'settlement', settlementDate: s.settledOn, settledAt: sql`now()`, ...(s.finalPrice != null ? { salePrice: String(s.finalPrice) } : {}), updatedAt: sql`now()` })
      .where(and(eq(deal.id, d.id), eq(deal.status, 'open')))
      .returning({ buyer: deal.buyerContactId, vendor: deal.vendorContactId });
    if (!row) throw new DealError('conflict', 'This deal is closed.');
    await record(tx, actor, d, { kind: 'settled', from: d.stage, to: 'settlement', note: `Settled on ${s.settledOn}` });
    let tagged = 0;
    if (s.tagPastClients) {
      for (const id of [row.buyer, row.vendor].filter((x): x is string => Boolean(x))) {
        const r = await tx.insert(contactRole).values({ contactId: id, role: 'past_client', source: 'inferred', createdBy: actor.userId }).onConflictDoNothing().returning({ id: contactRole.contactId });
        tagged += r.length;
      }
    }
    return { tagged };
  });
}

export async function addDealCondition(db: Db, actor: Actor, dealId: string, input: { label: string; dueOn?: string | null }): Promise<void> {
  const c = addConditionSchema.parse(input);
  const d = await loadForWrite(db, actor, dealId);
  await db.transaction(async (tx) => {
    const [{ n } = { n: 0 }] = await tx.execute<{ n: number }>(sql`select coalesce(max(sort), -1)::int + 1 as n from deal_condition where deal_id = ${d.id}`);
    await tx.insert(dealCondition).values({ dealId: d.id, agencyId: d.agency_id, kind: 'custom', label: c.label, dueOn: c.dueOn ?? null, sort: Number(n) });
    await record(tx, actor, d, { kind: 'condition', note: `Condition added: ${c.label}` });
  });
}

export async function updateDealCondition(db: Db, actor: Actor, conditionId: string, input: { dueOn?: string | null; done?: boolean }): Promise<void> {
  const c = updateConditionSchema.parse(input);
  if (!UUID.test(conditionId)) throw new DealError('not_found', 'That condition was not found.');
  const [row] = await db.select({ dealId: dealCondition.dealId, label: dealCondition.label, doneAt: dealCondition.doneAt }).from(dealCondition).where(and(eq(dealCondition.id, conditionId), eq(dealCondition.agencyId, actor.agencyId ?? '')));
  if (!row) throw new DealError('not_found', 'That condition was not found.');
  const d = await loadForWrite(db, actor, row.dealId);
  await db.transaction(async (tx) => {
    await tx
      .update(dealCondition)
      .set({ ...(c.dueOn !== undefined ? { dueOn: c.dueOn } : {}), ...(c.done !== undefined ? { doneAt: c.done ? sql`now()` : null } : {}), updatedAt: sql`now()` })
      .where(eq(dealCondition.id, conditionId));
    if (c.done !== undefined && c.done !== Boolean(row.doneAt)) await record(tx, actor, d, { kind: 'condition', note: `${row.label} ${c.done ? 'met' : 'reopened'}` });
  });
}

export async function removeDealCondition(db: Db, actor: Actor, conditionId: string): Promise<void> {
  if (!UUID.test(conditionId)) throw new DealError('not_found', 'That condition was not found.');
  const [row] = await db.select({ dealId: dealCondition.dealId, kind: dealCondition.kind, label: dealCondition.label }).from(dealCondition).where(and(eq(dealCondition.id, conditionId), eq(dealCondition.agencyId, actor.agencyId ?? '')));
  if (!row) throw new DealError('not_found', 'That condition was not found.');
  if (row.kind !== 'custom') throw new DealError('invalid', 'The standard conditions stay; leave its date empty if it does not apply.');
  const d = await loadForWrite(db, actor, row.dealId);
  await db.transaction(async (tx) => {
    await tx.delete(dealCondition).where(eq(dealCondition.id, conditionId));
    await record(tx, actor, d, { kind: 'condition', note: `Condition removed: ${row.label}` });
  });
}

/** Who might be the buyer: people who enquired on or offered for this listing, among those this person may see. */
export async function dealBuyerOptions(db: DbOrTx, actor: Actor, listingId: string): Promise<{ id: string; name: string }[]> {
  if (!actor.agencyId || !UUID.test(listingId) || !can(actor, 'listing:read', { type: 'listing', id: listingId, agencyId: actor.agencyId })) return [];
  return db.execute<{ id: string; name: string }>(sql`
    select distinct c.id, c.name from lead l join contact c on c.id = l.contact_id
    where l.listing_id = ${listingId} and c.agency_id = ${actor.agencyId} and c.archived_at is null and c.merged_into_id is null
      and c.id in (${visibleContactIdsSql(actor)})
    order by c.name limit 100`);
}
