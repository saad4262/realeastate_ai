import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Actor } from '../permissions';
import { classify } from './batches';
import { CLIENT_ROLES, hasMarketingConsentSql, INFERRED_CONSENT_MONTHS } from './consent';
import { mayUseTemplate } from './templates';

/** ADR 0043: who may send a template, what counts as consent, and that an unsubscribe always wins. */

const A = 'agency-a';
const owner: Actor = { userId: 'owner', agencyId: A, membershipRole: 'owner' };
const admin: Actor = { userId: 'admin', agencyId: A, membershipRole: 'admin' };
const agent: Actor = { userId: 'agent', agencyId: A, membershipRole: 'agent' };
const colleague: Actor = { userId: 'colleague', agencyId: A, membershipRole: 'agent' };
const viewer: Actor = { userId: 'viewer', agencyId: A, membershipRole: 'read_only' };
const rival: Actor = { userId: 'rival', agencyId: 'agency-b', membershipRole: 'owner' };
const tpl = (createdBy: string, agencyWide: boolean, status = 'approved', channel = 'email') => ({ agencyId: A, createdBy, agencyWide, status, channel });

describe('T1 — a template is usable by its author, or by everyone when it is the agency’s', () => {
  it('an agent’s own template: the agent only — not a colleague, not even an admin', () => {
    expect(mayUseTemplate(agent, tpl('agent', false))).toBe(true);
    expect(mayUseTemplate(colleague, tpl('agent', false))).toBe(false);
    expect(mayUseTemplate(admin, tpl('agent', false))).toBe(false);
  });
  it('an agency template: every member who may send; never a read-only member or another agency', () => {
    for (const a of [owner, admin, agent, colleague]) expect(mayUseTemplate(a, tpl('owner', true))).toBe(true);
    expect(mayUseTemplate(viewer, tpl('owner', true))).toBe(false);
    expect(mayUseTemplate(rival, tpl('owner', true))).toBe(false);
  });
  it('a retired template: nobody', () => {
    expect(mayUseTemplate(agent, tpl('agent', false, 'retired'))).toBe(false);
    expect(mayUseTemplate(owner, tpl('owner', true, 'retired'))).toBe(false);
  });
});

describe('T1b — ADR 0074: an SMS template never goes out as an email', () => {
  it('every email path (the default channel) refuses an SMS template, for every member', () => {
    for (const a of [owner, admin, agent]) {
      expect(mayUseTemplate(a, tpl('owner', true, 'approved', 'sms'))).toBe(false);
      expect(mayUseTemplate(a, tpl('owner', true, 'approved', 'sms'), 'email')).toBe(false);
    }
  });
  it('asked for SMS, an SMS template follows the same rules; an email template is refused', () => {
    expect(mayUseTemplate(agent, tpl('owner', true, 'approved', 'sms'), 'sms')).toBe(true);
    expect(mayUseTemplate(colleague, tpl('agent', false, 'approved', 'sms'), 'sms')).toBe(false);
    expect(mayUseTemplate(agent, tpl('owner', true, 'retired', 'sms'), 'sms')).toBe(false);
    expect(mayUseTemplate(agent, tpl('owner', true), 'sms')).toBe(false);
  });
});

describe('T2 — consent, and the opt-out first', () => {
  const base = { archived: false, optedOut: false, consent: true, email: 'a@b.test' };
  it('an unsubscribe wins over any consent, recorded or inferred', () => {
    expect(classify({ ...base, optedOut: true })).toBe('opted_out');
    expect(classify({ ...base, optedOut: true, consent: false })).toBe('opted_out');
  });
  it('no consent: skipped; consent and an address: sent; there is no repeat window', () => {
    expect(classify({ ...base, consent: false })).toBe('no_consent');
    expect(classify(base)).toBeNull();
    expect(classify({ ...base, email: null })).toBe('no_email');
    expect(classify({ ...base, archived: true })).toBe('archived');
  });
  it('the one definition: recorded, OR an enquiry in the last 24 months, OR a seller/landlord/tenant — never a buyer alone', () => {
    const q = new PgDialect().sqlToQuery(hasMarketingConsentSql());
    expect(q.sql).toMatch(/"contact"\."marketing_consent_at" is not null/);
    expect(q.sql).toMatch(/from lead consent_lead[\s\S]*consent_lead\.agency_id = "contact"\."agency_id"[\s\S]*make_interval\(months => \$1\)/);
    expect(q.params[0]).toBe(INFERRED_CONSENT_MONTHS);
    expect(INFERRED_CONSENT_MONTHS).toBe(24);
    expect([...CLIENT_ROLES]).toEqual(['seller', 'landlord', 'tenant']);
    expect(q.params).not.toContain('buyer');
    expect(q.params).not.toContain('investor');
    // It never reads the opt-out: that is classify's, tested first.
    expect(q.sql).not.toMatch(/opt_out/);
  });
});
