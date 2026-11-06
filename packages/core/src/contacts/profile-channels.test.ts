import { describe, expect, it, vi } from 'vitest';
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { activityListingIdsSql, searchWords, viewInScopeSql } from '../activity/scope';
import { getListingActivity, ListingActivityError, parseActivityDays } from '../activity/listing-activity';
import { logCallSchema, parseContactTab } from './contact-schema';
import { contactLeadSummary } from './lead-summary';
import { listContactCalls, listContactTexts, logContactCall, numberScopeSql, type ContactCall } from './communications';
import { listContactSiteHistory, siteRowsSql } from './site-history';
import { maskFigures, summarizeContact, summaryLine } from './summary';
import type { ReadableContact } from './get-contact';
import type { TimelineItem } from './timeline';

/** ADR 0083: the rules of the new channels, each pinned where it could quietly widen. Never the network. */

const dialect = new PgDialect();
const text = (q: SQL) => dialect.sqlToQuery(q);

const AGENCY = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const CONTACT = '33333333-3333-3333-3333-333333333333';
const owner: Actor = { userId: 'owner-1', agencyId: AGENCY, membershipRole: 'owner' };
const agent: Actor = { userId: 'agent-1', agencyId: AGENCY, membershipRole: 'agent' };
const viewer: Actor = { userId: 'viewer-1', agencyId: AGENCY, membershipRole: 'read_only' };
const stranger: Actor = { userId: 'x', agencyId: OTHER, membershipRole: 'owner' };
const ref = { id: CONTACT, agencyId: AGENCY } as ReadableContact;

function fakeDb(rows: unknown[] = []) {
  const statements: SQL[] = [];
  return {
    db: {
      execute: vi.fn(async (q: SQL) => (statements.push(q), rows)),
      // leadScopeFilters builds a sub-select; it is only ever embedded, never run.
      select: (fields: never) => new QueryBuilder().select(fields),
    } as unknown as Db,
    statements,
  };
}

describe('the permissions', () => {
  const contact = (ownerId?: string) => ({ type: 'contact' as const, id: CONTACT, agencyId: AGENCY, ...(ownerId ? { ownerId } : {}) });

  it('logging a call and asking for a summary follow note:create', () => {
    for (const action of ['contact_call:log', 'contact_summary:write'] as const) {
      expect(can(owner, action, contact()), action).toBe(true);
      expect(can(agent, action, contact('agent-1')), action).toBe(true);
      expect(can(agent, action, contact('someone-else')), action).toBe(false);
      expect(can(viewer, action, contact('viewer-1')), action).toBe(false);
      expect(can(stranger, action, contact()), action).toBe(false);
    }
  });

  it('listing activity: any member of THIS agency, nobody else', () => {
    const r = { type: 'listing' as const, agencyId: AGENCY };
    expect(can(owner, 'listing_activity:read', r)).toBe(true);
    expect(can(agent, 'listing_activity:read', r)).toBe(true);
    expect(can(viewer, 'listing_activity:read', r)).toBe(true);
    expect(can(stranger, 'listing_activity:read', r)).toBe(false);
    expect(can({ userId: 'u' }, 'listing_activity:read', r)).toBe(false);
  });

  it('a platform view reads texts and activity but never logs a call', () => {
    const view: Actor = { ...owner, via: 'platform', viewerId: 'admin-1' };
    expect(can(view, 'sms:read', { type: 'sms', agencyId: AGENCY })).toBe(true);
    expect(can(view, 'listing_activity:read', { type: 'listing', agencyId: AGENCY })).toBe(true);
    expect(can(view, 'contact_call:log', contact())).toBe(false);
    expect(can(view, 'contact_summary:write', contact())).toBe(false);
  });
});

describe('an agency sees its own listings, the rule of ADR 0083 §5', () => {
  it('an owner: the agency’s listings, always in the WHERE', () => {
    const q = text(activityListingIdsSql(owner));
    expect(q.sql).toContain('li.agency_id');
    expect(q.sql).not.toContain('listing_agent');
    expect(q.params).toContain(AGENCY);
  });

  it('an agent: only the listings they are named on', () => {
    const q = text(activityListingIdsSql(agent));
    expect(q.sql).toContain('listing_agent');
    expect(q.params).toEqual(expect.arrayContaining(['agent-1', AGENCY]));
  });

  it('a view is scoped by the row’s agency too, not only by the listing', () => {
    const q = text(viewInScopeSql(owner));
    expect(q.sql).toMatch(/a\.agency_id = \$\d/);
  });

  it('nobody with no agency reads anything: the zero uuid, never every agency', () => {
    const q = text(activityListingIdsSql({ userId: 'u' }));
    expect(q.params).toContain('00000000-0000-0000-0000-000000000000');
  });

  it('the profile’s rows are that scope, both for activity and for saves', () => {
    const q = text(siteRowsSql(agent, CONTACT));
    expect(q.sql).toContain('site_activity');
    expect(q.sql).toContain('shortlist');
    // The account rule and the agent's listing rule both reach the statement.
    expect(q.sql).toContain('listing_agent');
    expect(q.params).toContain(CONTACT);
  });

  it('search words come from what was typed, in order', () => {
    expect(searchWords({ bedrooms: 3, priceFrom: 650000, priceTo: 800000 }, { suburb: 'Pakenham', state: 'VIC', channel: 'sale' })).toBe('Pakenham VIC · buy · 3+ bed · $650,000–$800,000');
    expect(searchWords(null, { suburb: 'Officer' })).toBe('Officer');
  });
});

describe('the Listing activity page', () => {
  it('refuses an actor from nowhere', async () => {
    const { db } = fakeDb();
    await expect(getListingActivity(db, { userId: 'u' })).rejects.toBeInstanceOf(ListingActivityError);
  });

  it('leaves the agency’s own members out, in all three statements', async () => {
    const { db, statements } = fakeDb();
    await getListingActivity(db, owner);
    expect(statements).toHaveLength(3);
    for (const s of statements) expect(text(s).sql).toContain('membership');
  });

  it('never counts a private offer as an enquiry on the listing table', async () => {
    const { db, statements } = fakeDb();
    await getListingActivity(db, owner);
    expect(text(statements[1]!).sql).toContain("l.kind <> 'offer'");
  });

  it('a period off the list falls back to thirty days', () => {
    expect(parseActivityDays('7')).toBe(7);
    expect(parseActivityDays('9000')).toBe(30);
    expect(parseActivityDays(undefined)).toBe(30);
  });
});

describe('SMS and Calls stay in their own reads (ADR 0083 §1)', () => {
  it('the texts read asks sms_message and nothing about mail', async () => {
    const { db, statements } = fakeDb();
    await listContactTexts(db, owner, ref);
    expect(statements).toHaveLength(1);
    expect(text(statements[0]!).sql).toContain('sms_message');
    expect(text(statements[0]!).sql).not.toContain('mail_message');
  });

  it('the calls read has no texts or mail in it', async () => {
    const { db, statements } = fakeDb();
    await listContactCalls(db, owner, ref);
    const q = text(statements[0]!).sql;
    expect(q).toContain('phone_call');
    expect(q).toContain("'call_logged'");
    expect(q).not.toContain('sms_message');
    expect(q).not.toContain('mail_message');
  });

  it('an agent’s texts and calls narrow to their own number; an owner’s do not', () => {
    expect(text(numberScopeSql(agent, AGENCY)).sql).toContain('pn.user_id');
    expect(text(numberScopeSql(agent, AGENCY)).params).toContain('agent-1');
    expect(text(numberScopeSql(owner, AGENCY)).sql).not.toContain('pn.user_id');
  });

  it('a row that names somebody else is never taken by a shared phone', async () => {
    const { db, statements } = fakeDb();
    await listContactTexts(db, owner, ref);
    expect(text(statements[0]!).sql).toMatch(/m\.contact_id is null and public\.au_phone_key\(m\.counterpart\)/);
  });

  it('groups texts by conversation, oldest first inside each, with the stats', async () => {
    const row = (id: string, n: string, at: string, direction: 'in' | 'out', status = 'delivered') => ({
      id, phone_number_id: n, counterpart: '+61412000111', e164: '+61480000222', direction, body: id, status, error: null, kind: null,
      created_at: at, agent_name: 'Sam', by_name: null, opted_out: false, total: '3', received: '1', sent: '2', failed: '1',
    });
    const { db } = fakeDb([row('c', 'n1', '2026-11-03', 'in'), row('b', 'n2', '2026-11-02', 'out', 'failed'), row('a', 'n1', '2026-11-01', 'out')]);
    const r = await listContactTexts(db, owner, ref);
    expect(r).toMatchObject({ total: 3, received: 1, sent: 2, failed: 1 });
    expect(r.conversations.map((c) => c.phoneNumberId)).toEqual(['n1', 'n2']);
    expect(r.conversations[0]!.messages.map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('reads a logged call’s payload, and a bad payload cannot widen its outcome', async () => {
    const base = { from_e164: null, who: 'Sam', outcome: null, handled_at: null, ai_status: null, ai_summary: null, ai_duration_s: null, total: '2', missed: '0', ai: '0', logged: '2' };
    const { db } = fakeDb([
      { ...base, source: 'logged', id: 'a', at: '2026-11-02', payload: { direction: 'in', outcome: 'voicemail', minutes: 4, note: 'Hello' } },
      { ...base, source: 'logged', id: 'b', at: '2026-11-01', payload: { outcome: 'nonsense', minutes: 'x' } },
    ]);
    const r = await listContactCalls(db, owner, ref);
    const [a, b] = r.rows as Extract<ContactCall, { source: 'logged' }>[];
    expect(a).toMatchObject({ direction: 'in', outcome: 'voicemail', minutes: 4, note: 'Hello' });
    expect(b).toMatchObject({ direction: 'out', outcome: 'answered', minutes: null, note: null });
    expect(r.logged).toBe(2);
  });

  it('old links land: the tab keys still parse, and the new ones do', () => {
    for (const t of ['enquiries', 'emails', 'sms', 'calls', 'messages', 'activity']) expect(parseContactTab(t)).toBe(t);
    expect(parseContactTab('nonsense')).toBe('overview');
  });
});

describe('logging a call', () => {
  function headDb(head: Record<string, unknown> | null) {
    const inserted: Record<string, unknown>[] = [];
    const chain = { from: () => chain, leftJoin: () => chain, where: () => chain, limit: async () => (head ? [head] : []) };
    return {
      db: {
        select: () => chain,
        insert: () => ({ values: async (v: Record<string, unknown>) => void inserted.push(v) }),
      } as unknown as Db,
      inserted,
    };
  }
  const head = { id: CONTACT, agencyId: AGENCY, assignedTo: 'agent-1', mergedIntoId: null, leadAssigneeIds: null, listingAgentIds: null };
  const good = { direction: 'out', outcome: 'answered', minutes: 6, note: 'Confirmed Saturday' };

  it('the assignee logs it, as one activity row, with who did it', async () => {
    const { db, inserted } = headDb(head);
    await logContactCall(db, agent, CONTACT, good);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ kind: 'call_logged', actorId: 'agent-1', agencyId: AGENCY, contactId: CONTACT, payload: good });
  });

  it('somebody who cannot see the contact gets not-found, nothing written', async () => {
    const { db, inserted } = headDb({ ...head, assignedTo: 'someone-else' });
    await expect(logContactCall(db, agent, CONTACT, good)).rejects.toMatchObject({ code: 'not_found' });
    expect(inserted).toEqual([]);
  });

  it('a read-only member who can see it is refused, nothing written', async () => {
    const { db, inserted } = headDb({ ...head, assignedTo: 'viewer-1' });
    await expect(logContactCall(db, viewer, CONTACT, good)).rejects.toMatchObject({ code: 'forbidden' });
    expect(inserted).toEqual([]);
  });

  it('a bad call is refused before it is written', async () => {
    const { db, inserted } = headDb(head);
    await expect(logContactCall(db, agent, CONTACT, { ...good, minutes: 9000 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(logContactCall(db, agent, CONTACT, { ...good, outcome: 'won the lottery' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(logContactCall(db, agent, CONTACT, { ...good, agencyId: OTHER })).rejects.toMatchObject({ code: 'invalid' });
    expect(inserted).toEqual([]);
    expect(logCallSchema.safeParse(good).success).toBe(true);
  });
});

describe('the lead summary', () => {
  it('reads under the inbox’s scope, and an automatic send is not a reply', async () => {
    const { db, statements } = fakeDb([{ total: '4', new: '1', contacted: '1', qualified: '0', closed: '2', enquiry: '2', inspection: '1', appraisal: '1', offer: '0', sources: [{ source: 'website', count: 3 }], first_at: '2026-10-03', latest_at: '2026-11-05', average_reply: '7800', waiting: '1', open_deals: '1' }]);
    const s = await contactLeadSummary(db, agent, ref);
    expect(s).toMatchObject({ total: 4, new: 1, closed: 2, averageFirstReplySeconds: 7800, waiting: 1, openDeals: 1 });
    const q = text(statements[0]!).sql;
    expect(q).toContain('m.sent_by is not null');
    expect(q).toContain('s.sent_by is not null');
    // An agent never counts an offer, and sees only their own deals.
    expect(q).toContain('"lead"."kind" <>');
    expect(q).toContain('d.agent_id');
    expect(text(statements[0]!).params).toContain('agent-1');
  });

  it('an owner sees every deal; nothing reads as zeros, with no average', async () => {
    const { db, statements } = fakeDb([]);
    const s = await contactLeadSummary(db, owner, ref);
    expect(s).toMatchObject({ total: 0, averageFirstReplySeconds: null, bySource: [] });
    expect(text(statements[0]!).sql).not.toContain('d.agent_id');
  });
});

describe('the activity tab', () => {
  it('one row even when nothing matched, and JSON rows read back', async () => {
    const empty = await listContactSiteHistory(fakeDb([{ tie: 'none', views: '0', listings: '0', searches: '0', saved: '0', total: '0', rows: null }]).db, owner, ref);
    expect(empty).toMatchObject({ tie: 'none', total: 0, rows: [] });
    const full = await listContactSiteHistory(
      fakeDb([{ tie: 'email', views: '1', listings: '1', searches: '1', saved: '0', total: '2', rows: [
        { id: 'a', kind: 'view', at: '2026-11-02T00:00:00Z', listing_id: 'l1', address: '12 Rose Court, Pakenham', query: null, suburb: 'Pakenham', state: 'VIC', channel: 'sale' },
        { id: 'b', kind: 'search', at: '2026-11-01T00:00:00Z', listing_id: null, address: null, query: { bedrooms: 3 }, suburb: 'Officer', state: 'VIC', channel: 'sale' },
      ] }]).db,
      owner,
      ref,
    );
    expect(full.tie).toBe('email');
    expect(full.rows.map((r) => r.what)).toEqual(['12 Rose Court, Pakenham', 'Officer VIC · buy · 3+ bed']);
  });
});

describe('what the summary hands the model (ADR 0083 §8)', () => {
  const at = new Date('2026-11-01');
  it('no figure survives into the input', () => {
    expect(maskFigures('Budget $750,000, call 0412 345 678 at 10:30 on 3/11')).not.toMatch(/\d/);
    const line = summaryLine({ type: 'sms', id: 'a', at, direction: 'in', failed: false, automatic: false, body: 'Is $800k ok for 3 bed?', who: null } satisfies TimelineItem)!;
    expect(line).not.toMatch(/\d/);
    expect(line).toContain('[figure]');
  });

  it('a private note is left out, whoever is asking', () => {
    expect(summaryLine({ type: 'note', id: 'a', at, body: 'secret', who: null, isPrivate: true })).toBeNull();
    expect(summaryLine({ type: 'note', id: 'a', at, body: 'shared', who: null, isPrivate: false })).toContain('shared');
  });

  it('browsing is an event and never carries its address or search filters', () => {
    const line = summaryLine({ type: 'site', id: 'a', at, kind: 'view', what: '12 Rose Court, Pakenham', who: null })!;
    expect(line).toBe('OPENED A LISTING');
  });

  it('no summarizer configured: refused plainly, before anything is read for the model', async () => {
    const chain = { from: () => chain, leftJoin: () => chain, where: () => chain, limit: async () => [{ id: CONTACT, agencyId: AGENCY, assignedTo: 'agent-1', mergedIntoId: null, leadAssigneeIds: null, listingAgentIds: null }] };
    const db = { select: () => chain } as unknown as Db;
    await expect(summarizeContact(db, agent, CONTACT, null)).rejects.toMatchObject({ code: 'invalid' });
  });
});
