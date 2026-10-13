import { describe, expect, it } from 'vitest';
import { issueHandle, resolveHandle, type HandleMap } from './handles';
import { ASSISTANT_TEAM_TOOLS, ASSISTANT_TOOL_INPUTS, LIST_SEND, PLANNABLE_TOOLS, PROPOSED_ACTION_TOOLS, handleSchema } from './schema';
import { needsConnection } from './write-tools';

/** ADR 0040 part 2: the connect shape, saved lists, listings and invites — what holds without a database. */

describe('"Connect X first", one shape (§1)', () => {
  it('names each account that is not connected, with whether this person may connect it — and nothing else', () => {
    const out = needsConnection([
      { provider: 'zoom', state: 'not_connected', mayConnect: true },
      { provider: 'google_calendar', state: 'connected', mayConnect: true },
      { provider: 'gmail', state: 'expired', mayConnect: false },
    ]);
    expect(out).toEqual([
      { provider: 'zoom', label: 'Zoom', may_connect: true },
      { provider: 'gmail', label: 'Gmail (send only)', may_connect: false },
    ]);
    // No URL travels to the model: the panel draws the button from its own surface's path.
    expect(JSON.stringify(out)).not.toMatch(/http|\//);
  });
});

describe('saved lists (§2)', () => {
  it('an F reference names a saved list, and only a saved list', () => {
    const map: HandleMap = {};
    const f = issueHandle(map, 'F', '11111111-1111-4111-8111-111111111111');
    expect(f).toBe('F1');
    expect(handleSchema.safeParse('F1').success).toBe(true);
    expect(resolveHandle(map, 'F1', 'filter')).toBe('11111111-1111-4111-8111-111111111111');
    expect(resolveHandle(map, 'F1', 'contact')).toBeNull();
  });
  it('template email takes recipients OR a list — never both, never neither', () => {
    const p = (v: unknown) => ASSISTANT_TOOL_INPUTS.send_template_email.safeParse(v).success;
    expect(p({ template: 'T1', recipients: ['C1'] })).toBe(true);
    expect(p({ template: 'T1', list: 'F2' })).toBe(true);
    expect(p({ template: 'T1', list: 'F2', recipients: ['C1'] })).toBe(false);
    expect(p({ template: 'T1' })).toBe(false);
    expect(p({ template: 'T1', list: 'C1' })).toBe(false);
  });
  it('a list card is bounded: 100 people, one part a day', () => {
    expect(LIST_SEND).toEqual({ maxPeople: 100, gapHours: 24 });
  });
  it('send_template_email is still not a plan step (its parts are made by the list card alone)', () => {
    expect(PLANNABLE_TOOLS as readonly string[]).not.toContain('send_template_email');
  });
});

describe('listings (§4)', () => {
  const base = { channel: 'sale', suburb: 'Ryde', state: 'NSW', postcode: '2112', headline: 'Family home' };
  it('a draft needs an address and a headline; it has no status, agent or agency to set', () => {
    const p = (v: unknown) => ASSISTANT_TOOL_INPUTS.create_listing_draft.safeParse(v).success;
    expect(p(base)).toBe(true);
    expect(p({ ...base, postcode: '211' })).toBe(false);
    expect(p({ ...base, state: 'XX' })).toBe(false);
    for (const extra of [{ status: 'live' }, { agent: 'M1' }, { agency_id: 'x' }, { latitude: -33.8 }, { auction_date: '2026-11-01' }]) {
      expect(p({ ...base, ...extra }), JSON.stringify(extra)).toBe(false);
    }
  });
  it('an edit names a listing by P reference and only the edit form’s fields', () => {
    const p = (v: unknown) => ASSISTANT_TOOL_INPUTS.update_listing.safeParse(v).success;
    expect(p({ listing: 'P1', price_display: 'Offers over $900,000', price_low: 900000 })).toBe(true);
    expect(p({ listing: 'P1', bedrooms: null })).toBe(true);
    for (const extra of [{ suburb: 'Ryde' }, { street: 'George St' }, { status: 'withdrawn' }, { channel: 'rent' }]) {
      expect(p({ listing: 'P1', ...extra }), JSON.stringify(extra)).toBe(false);
    }
    expect(p({ listing: 'L1', headline: 'x' })).toBe(false);
  });
  it('every listing tool may be a plan step; the invite never is', () => {
    for (const t of ['create_listing_draft', 'update_listing', 'withdraw_listing', 'submit_listing']) expect(PLANNABLE_TOOLS as readonly string[]).toContain(t);
    expect(PLANNABLE_TOOLS as readonly string[]).not.toContain('invite_agent');
  });
});

describe('inviting an agent (§3)', () => {
  const ok = { first_name: 'Sara', last_name: 'Khan', email: 'sara@example.com', phone: '0418 920 441', licence_number: '20123456', territory_suburbs: ['Ryde'] };
  it('needs the wizard’s required fields; role defaults to an agent', () => {
    const r = ASSISTANT_TOOL_INPUTS.invite_agent.safeParse(ok);
    expect(r.success && r.data.role).toBe('senior');
    for (const k of Object.keys(ok)) {
      const { [k]: _gone, ...without } = ok as Record<string, unknown>;
      expect(ASSISTANT_TOOL_INPUTS.invite_agent.safeParse(without).success, k).toBe(false);
    }
    expect(ASSISTANT_TOOL_INPUTS.invite_agent.safeParse({ ...ok, territory_suburbs: [] }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.invite_agent.safeParse({ ...ok, role: 'owner' }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.invite_agent.safeParse({ ...ok, commission_tier: 't3' }).success).toBe(false);
  });
  it('is a team tool: owners and admins only', () => {
    expect(ASSISTANT_TEAM_TOOLS as readonly string[]).toContain('invite_agent');
  });
});

describe('the database CHECK list (migration 0048)', () => {
  it('holds every new card tool', () => {
    for (const t of ['create_listing_draft', 'update_listing', 'withdraw_listing', 'submit_listing', 'invite_agent']) expect(PROPOSED_ACTION_TOOLS as readonly string[]).toContain(t);
    expect(PROPOSED_ACTION_TOOLS as readonly string[]).not.toContain('find_saved_lists');
  });
});
