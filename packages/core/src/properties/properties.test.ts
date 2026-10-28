import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Actor } from '../permissions';
import { appointmentVisibleSql, leadVisibleSql, visiblePropertyIdsSql } from './visibility';
import { peopleOf, timelineOf, type PropertyLead, type PropertyView } from './property-page';
import { checkPropertySummary, propertyRecords, summarizeProperty, type PropertyRecord } from './summary';

/** ADR 0065: one property with everything on it — through the rules that already decide each record. */

const A = '11111111-1111-1111-1111-111111111111';
const owner: Actor = { userId: 'u-owner', agencyId: A, membershipRole: 'owner' };
const agent: Actor = { userId: 'u-agent', agencyId: A, membershipRole: 'agent' };
const q = (s: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(s).sql;

describe('who sees what', () => {
  it('shows offers to owners and admins only, and narrows an agent to their own leads', () => {
    expect(q(leadVisibleSql(owner))).not.toContain("kind <> 'offer'");
    const mine = q(leadVisibleSql(agent));
    expect(mine).toContain("l.kind <> 'offer'");
    expect(mine).toContain('l.assigned_to = $');
    expect(mine).toContain('la.listing_id = l.listing_id');
  });
  it('narrows an agent’s appointments to theirs', () => {
    expect(q(appointmentVisibleSql(owner))).not.toContain('assigned_agent_id');
    expect(q(appointmentVisibleSql(agent))).toContain('a.assigned_agent_id = $');
  });
  it('opens any address the agency has a record of for an owner, and only an agent’s own for an agent', () => {
    const all = q(visiblePropertyIdsSql(owner));
    expect(all).toContain('from deal d where d.agency_id = $');
    expect(all).toContain('from document doc');
    const own = q(visiblePropertyIdsSql(agent));
    expect(own).toContain('join listing_agent la on la.listing_id = li.id and la.user_id = $');
    expect(own).not.toContain('from document doc');
    expect(own).toContain("l.kind <> 'offer'");
  });
  it('opens nothing for someone with no membership', () => {
    expect(q(visiblePropertyIdsSql({ userId: 'x' }))).toContain('where false');
  });
});

const lead = (o: Partial<PropertyLead>): PropertyLead => ({
  id: Math.random().toString(36), kind: 'enquiry', status: 'new', name: 'Mia Chen', message: null, offerAmount: null,
  createdAt: new Date('2026-10-09T00:00:00Z'), listingId: 'li-1', contactId: 'c-mia', ...o,
});

describe('people', () => {
  it('puts each person on one row with every way they are tied to the address, owners first', () => {
    const people = peopleOf(
      [{ contact_id: 'c-priya', relation: 'owner', created_at: '2026-08-18T00:00:00Z', name: 'Priya Mehta', email: null, phone: '0412', linked_by: 'Sarah' }],
      [lead({ contactId: 'c-ravi', name: 'Ravi Patel', kind: 'inspection' }), lead({ contactId: 'c-ravi', name: 'Ravi Patel', kind: 'offer', offerAmount: 715000 })],
      { vendorId: 'c-priya', buyerId: null, contacts: [{ id: 'c-priya', name: 'Priya Mehta', email: null, phone: '0412' }] },
    );
    expect(people.map((p) => p.name)).toEqual(['Priya Mehta', 'Ravi Patel']);
    expect(people[0]!.roles).toEqual(['Owner', 'Vendor']);
    expect(people[1]!.roles).toEqual(['Made an offer', 'Asked to inspect']);
  });
});

describe('what has happened', () => {
  it('is newest first, leaves out cancelled appointments and open homes still to come, and says when a deal moved by itself', () => {
    const now = new Date('2026-10-27T00:00:00Z');
    const t = timelineOf({
      listings: [{ id: 'li-1', channel: 'sale', status: 'under_offer', priceText: '$700,000 – $750,000', soldPrice: null, soldDate: null, publishedAt: new Date('2026-09-02T00:00:00Z'), createdAt: new Date('2026-09-01T00:00:00Z'), agentName: 'Omar', photoKey: null, mayEdit: true, daysOnMarket: 55 }],
      deal: { id: 'd', stage: 'negotiation', status: 'open', listingId: 'li-1', salePrice: null, contractDate: null, settlementDate: null, settledAt: null, agentName: 'Omar', commissionSet: null, conditions: [], events: [
        { kind: 'stage', fromStage: 'offers', toStage: 'negotiation', auto: true, note: 'The listing was marked Under offer', at: new Date('2026-10-21T01:00:00Z'), actorName: null },
        { kind: 'edited', fromStage: null, toStage: null, auto: false, note: 'Sale details changed', at: new Date('2026-10-22T00:00:00Z'), actorName: 'Sarah' },
      ] },
      leads: [lead({ kind: 'offer', offerAmount: 742000, name: 'Hannah Lee', createdAt: new Date('2026-10-21T02:00:00Z') })],
      appointments: [{ id: 'a', title: 'x', type: 'inspection', typeLabel: 'Inspection', status: 'cancelled', startsAt: new Date('2026-10-20T00:00:00Z'), timezone: 'Australia/Melbourne', outcome: null, contactName: null, agentName: null }],
      inspections: [
        { id: 'i1', kind: 'open', startsAt: new Date('2026-10-11T00:00:00Z'), listingId: 'li-1' },
        { id: 'i2', kind: 'open', startsAt: new Date('2026-11-01T00:00:00Z'), listingId: 'li-1' },
      ],
      documents: [],
      links: [],
      now,
    });
    expect(t.map((e) => e.title)).toEqual(['Private offer · $742,000', 'Deal moved to Negotiation', 'Open home', 'Listing went live']);
    expect(t[1]!.who).toBe('automatic');
  });
});

const view = (o: Partial<PropertyView> = {}): PropertyView => ({
  scope: 'agency', maySeeOffers: true, timeZone: 'Australia/Melbourne',
  facts: { id: 'p', address: '12/1A Rogers Street, Pakenham', suburb: 'Pakenham', state: 'VIC', postcode: '3810', propertyType: 'townhouse', bedrooms: 3, bathrooms: 2, carSpaces: 2, landAreaSqm: 312, buildingAreaSqm: null, yearBuilt: 2014 },
  listings: [], current: null, deal: null, offers: null, leads: [], appointments: [], inspections: [], documents: [], people: [], timeline: [], ...o,
});

describe('the records the summary is written from', () => {
  const now = new Date('2026-10-27T00:00:00Z');
  it('numbers what the person may see, with the counts worked out here, and offers only for those who may see them', () => {
    const recs = propertyRecords(view({ leads: [lead({}), lead({ kind: 'offer', offerAmount: 742000, name: 'Hannah Lee' })] }), now);
    expect(recs.map((r) => r.ref)).toEqual(['P', 'T', 'E1', 'E2']);
    expect(recs[1]!.text).toContain('1 enquiries');
    expect(recs[1]!.text).toContain('1 private offers');
    expect(recs[3]!.text).toContain('Private offer of $742,000 from Hannah Lee');
    const agents = propertyRecords(view({ maySeeOffers: false, leads: [lead({})] }), now);
    expect(agents[1]!.text).not.toContain('offers');
  });
});

describe('checking the summary', () => {
  const records: PropertyRecord[] = [
    { ref: 'P', tab: 'overview', label: 'Property', text: 'The property: 12/1A Rogers Street. townhouse, 3 bed.' },
    { ref: 'E1', tab: 'enquiries', label: 'Offer 21 Oct', text: '2026-10-21 Private offer of $742,000 from Hannah Lee, status contacted.' },
  ];
  it('keeps a point whose figures are in the records it cites, and links each citation to its tab', () => {
    expect(checkPropertySummary([{ text: 'Hannah Lee offered $742,000 on 21 Oct.', refs: ['E1'] }], records)).toEqual([
      { text: 'Hannah Lee offered $742,000 on 21 Oct.', cites: [{ ref: 'E1', label: 'Offer 21 Oct', tab: 'enquiries' }] },
    ]);
  });
  it('drops a point that cites nothing real or states a figure its records do not hold', () => {
    expect(checkPropertySummary([{ text: 'An offer came in.', refs: ['E9'] }], records)).toEqual([]);
    expect(checkPropertySummary([{ text: 'It is worth $800,000.', refs: ['P', 'E1'] }], records)).toEqual([]);
    expect(checkPropertySummary([{ text: 'Hannah offered $742,000.', refs: ['P'] }], records)).toEqual([]);
  });
  it('keeps six at most', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ text: `Point ${i === 0 ? '' : 'again'} about the townhouse.`, refs: ['P'] }));
    expect(checkPropertySummary(many, records)).toHaveLength(6);
  });
  it('says so when the server has no assistant', async () => {
    await expect(summarizeProperty({} as never, owner, 'p', null)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
