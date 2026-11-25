import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { auditSentence, listAuditLog } from './index';

/** PLATFORM-PLAN 1.20: who may read an agency's audit log, and that every sensitive action writes to it. */
const A = '11111111-1111-1111-1111-111111111111';
const who = (membershipRole: Actor['membershipRole'], agencyId: string | undefined = A): Actor => ({ userId: '33333333-3333-3333-3333-333333333333', agencyId, membershipRole });

function readDb() {
  const asked: string[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'leftJoin', 'orderBy']) chain[m] = () => chain;
  chain.where = () => {
    asked.push('where');
    return chain;
  };
  chain.limit = (n: number) => {
    asked.push(`limit ${n}`);
    return Promise.resolve([{ action: 'member_removed' }]);
  };
  return { db: chain as unknown as Db, asked };
}

describe('listAuditLog', () => {
  it('owners and admins read their own agency’s log', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const { db, asked } = readDb();
      expect(await listAuditLog(db, who(role))).toEqual([{ action: 'member_removed' }]);
      expect(asked).toEqual(['where', 'limit 100']);
    }
  });

  it('everyone else reads nothing, and no query runs', async () => {
    for (const actor of [who('agent'), who('assistant'), who('read_only'), who('property_manager'), { userId: '33333333-3333-3333-3333-333333333333', membershipRole: 'owner' } as Actor]) {
      const { db, asked } = readDb();
      expect(await listAuditLog(db, actor)).toEqual([]);
      expect(asked).toEqual([]);
    }
  });

  it('the limit is bounded', async () => {
    const { db, asked } = readDb();
    await listAuditLog(db, who('owner'), { limit: 100_000 });
    expect(asked).toContain('limit 500');
  });
});

/**
 * The wiring, as a static check: each sensitive action calls recordAudit in its own body. A new sensitive
 * action belongs in this list (14.8 checklist).
 */
describe('every sensitive action writes the audit log', () => {
  const root = join(__dirname, '..');
  const body = (file: string, fn: string) => {
    const src = readFileSync(join(root, file), 'utf8');
    const start = src.indexOf(`export async function ${fn}(`);
    expect(start, `${fn} in ${file}`).toBeGreaterThan(-1);
    const next = src.indexOf('\nexport ', start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  };
  it.each([
    ['team/offboarding.ts', 'removeMember', 'member_removed'],
    ['team/offboarding.ts', 'restoreMember', 'member_restored'],
    ['team/edit-member.ts', 'editTeamMember', 'member_edited'],
    ['team/edit-member.ts', 'withdrawInvite', 'invite_withdrawn'],
    ['team/invite-agent.ts', 'inviteAgent', 'invite_sent'],
    ['team/invite-agent.ts', 'claimAgentInvite', 'invite_claimed'],
    ['listings/delete-listing.ts', 'deleteListing', 'listing_deleted'],
  ])('%s %s → %s', (file, fn, action) => {
    const b = body(file, fn);
    expect(b).toMatch(/recordAudit\(tx,/);
    expect(b).toContain(`'${action}'`);
  });
});

describe('auditSentence', () => {
  const row = (action: string, detail: Record<string, unknown> = {}, subjectName: string | null = 'Sam Lee') => ({ action, detail, subjectName });
  it('says what happened, to whom, with roles and field names only', () => {
    expect(auditSentence(row('member_removed', { role: 'agent', workTo: 'x' }))).toBe('Removed Sam Lee (agent) from the agency');
    expect(auditSentence(row('member_edited', { fields: ['phone', 'operationalRole'], roleTo: 'admin' }))).toBe('Edited Sam Lee (phone, operationalRole); role now admin');
    expect(auditSentence(row('sends_paused', { reason: 'Far above usual.', figures: {} }, null))).toBe('Sends paused automatically: Far above usual.');
    // ADR 0101: what was downloaded and how much, never which people.
    expect(auditSentence(row('data_exported', { dataset: 'contacts', scope: 'own', rows: 1, complete: true }))).toBe('Downloaded contacts as CSV (1 row)');
    expect(auditSentence(row('data_exported', { dataset: 'listings', rows: 40, complete: false }))).toBe('Downloaded listings as CSV (40 rows, stopped before the end)');
    expect(auditSentence(row('data_exported', { dataset: 'contacts', rows: null }))).toBe('Downloaded contacts as CSV (rows not counted)');
    expect(auditSentence(row('listing_deleted', { status: 'draft' }, null))).toBe('Deleted a listing (it was draft)');
  });
  it('a deleted person is "a former member"; an unknown action is shown as stored', () => {
    expect(auditSentence(row('member_restored', {}, null))).toBe('Restored a former member to the agency');
    expect(auditSentence(row('something_new'))).toBe('something_new');
  });
});
