import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { can, type Action, type Actor, type MembershipRole } from '../permissions';

/**
 * Tenant isolation, layer 1 (ADR 0030): every action can() knows, asked by
 * every role of agency A about a resource of agency B, is refused.
 *
 * The action list is read from permissions.ts itself, so a new action is in
 * this matrix the moment it is written — nobody has to remember to add it.
 * The B resource is rigged to tempt every ownership rule: it names the A
 * actor as owner, assignee, listing agent, booker and lead assignee. Only the
 * agency differs, and that alone must be enough to refuse.
 */

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function allActions(): Action[] {
  const src = readFileSync(join(__dirname, '..', 'permissions.ts'), 'utf8');
  const start = src.indexOf('export type Action =');
  const end = src.indexOf(';', src.indexOf("| '", start) + 1);
  const block = src.slice(start, src.indexOf('\n\nexport', start) > 0 ? src.indexOf('\n\nexport', start) : end);
  const found = [...block.matchAll(/\|\s*'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1] as Action);
  return [...new Set(found)];
}

/**
 * Actions that are not agency data at all — a public-site visitor's own saved
 * searches and chats (ADR 0011). They are owned by a person, never an agency,
 * so "same agency" is not their question; their own test proves another
 * PERSON is refused. Everything else must refuse across agencies.
 */
const PERSONAL_NOT_AGENCY: readonly Action[] = ['schedule:create', 'schedule:read', 'schedule:manage', 'chat:read', 'chat:write', 'mail:read_own', 'meeting:read_own'];

/**
 * Surface gates: "may this person use the agency/agent console at all?" They
 * ask only about the actor's OWN membership and ignore the resource, so there
 * is no other agency's thing for them to reach.
 */
const SURFACE_GATES: readonly Action[] = ['console:agency', 'console:agent'];

/** Every membership role — read from the type at compile time (a missing one is a type error). */
const ROLE_SET: Record<MembershipRole, true> = { owner: true, admin: true, agent: true, assistant: true, property_manager: true, read_only: true };
const ROLES = Object.keys(ROLE_SET) as MembershipRole[];

describe('tenant isolation — can() never lets agency A act on agency B', () => {
  const actions = allActions();

  it('found the whole action list (guards the parser)', () => {
    expect(actions.length).toBeGreaterThan(50);
    for (const known of ['listing:edit', 'contact:read', 'proposed_action:decide', 'integration:use', 'assistant:use'] as Action[]) {
      expect(actions).toContain(known);
    }
  });

  for (const role of ROLES) {
    it(`${role} of A is refused every agency action on B`, () => {
      const actor: Actor = { userId: 'a-user', agencyId: A, membershipRole: role, listingAgentOf: ['b-listing'] };
      const allowed: string[] = [];
      for (const action of actions) {
        if (PERSONAL_NOT_AGENCY.includes(action) || SURFACE_GATES.includes(action)) continue;
        for (const integrationOwnerType of ['user', 'agency'] as const) {
          const resource = {
            type: action.split(':')[0]!,
            id: 'b-thing',
            agencyId: B,
            // Every way a rule could say "this is yours":
            ownerId: integrationOwnerType === 'agency' ? A : actor.userId,
            listingId: 'b-listing',
            leadAssigneeIds: [actor.userId],
            listingAgentIds: [actor.userId],
            createdBy: actor.userId,
            integrationOwnerType,
          };
          if (can(actor, action, resource)) allowed.push(`${action} (${integrationOwnerType})`);
        }
      }
      expect(allowed).toEqual([]);
    });
  }

  it('a resource with NO agency is never treated as the actor’s own (except the platform skill library)', () => {
    const actor: Actor = { userId: 'a-user', agencyId: A, membershipRole: 'owner' };
    const allowed = actions
      .filter((a) => !PERSONAL_NOT_AGENCY.includes(a) && !SURFACE_GATES.includes(a))
      .filter((a) => can(actor, a, { type: a.split(':')[0]!, id: 'x', ownerId: 'someone-else' }));
    // skill:read with no agency = the platform's own library, readable by every member (ADR 0021).
    expect(allowed.filter((a) => a !== 'skill:read')).toEqual([]);
  });

  it('someone with no membership is refused every agency action', () => {
    const actor: Actor = { userId: 'a-user' };
    const allowed = actions
      .filter((a) => !PERSONAL_NOT_AGENCY.includes(a))
      .filter((a) => can(actor, a, { type: a.split(':')[0]!, id: 'x', agencyId: A, ownerId: 'a-user' }));
    expect(allowed).toEqual([]);
  });
});
