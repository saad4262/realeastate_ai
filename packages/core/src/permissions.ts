/**
 * Central authorization. Never check roles in apps/ or UI —
 * always call can(actor, action, resource).
 */
export type MembershipRole =
  | 'owner'
  | 'admin'
  | 'agent'
  | 'assistant'
  | 'property_manager'
  | 'read_only';

export type Actor = {
  userId: string;
  agencyId?: string;
  membershipRole?: MembershipRole;
  /** Listing IDs where actor appears in listing_agent */
  listingAgentOf?: string[];
};

export type Action =
  | 'listing:read'
  | 'listing:create'
  | 'listing:edit'
  | 'listing:publish'
  /** Remove a listing outright. Narrower than edit — admins only. */
  | 'listing:delete'
  | 'team:manage'
  | 'agency:billing'
  /** Agency OS host — owner|admin only */
  | 'console:agency'
  /** Agent desk host — any active membership */
  | 'console:agent'
  /** Save a scheduled search. Any signed-in account; no agency required. */
  | 'schedule:create'
  /** Read a schedule and its runs — /alerts, the chat card, the run detail. */
  | 'schedule:read'
  /** Pause, resume, rename, retime, delete. */
  | 'schedule:manage'
  /** Read one's own saved conversations. */
  | 'chat:read'
  /** Append to, or delete, one's own saved conversations. */
  | 'chat:write';

export type Resource = {
  type: 'listing' | 'team' | 'agency' | 'console' | 'schedule' | 'chat' | string;
  id?: string;
  agencyId?: string;
  /**
   * Whose thing this is, for resources a person owns rather than an agency
   * does.
   *
   * A consumer has no agency, so `sameAgency` can never be the question for
   * one of their resources. This is the second axis the model needed and the
   * reason a consumer did not have to be given a fake membership — see
   * docs/adr/0011.
   */
  ownerId?: string;
};

const ADMIN_ROLES: MembershipRole[] = ['owner', 'admin'];

/**
 * Does this role run the agency rather than sell for it?
 * Display code asks this instead of comparing role strings itself.
 */
export function isAgencyAdminRole(role: MembershipRole | null | undefined): boolean {
  return Boolean(role && ADMIN_ROLES.includes(role));
}

const ROLE_PHRASES: Record<MembershipRole, string> = {
  owner: 'the owner',
  admin: 'an admin',
  agent: 'an agent',
  assistant: 'an assistant',
  property_manager: 'a property manager',
  read_only: 'a read-only member',
};

/**
 * Human phrase for a role, for message copy only — "you are already the owner".
 * Never a permission decision; those stay in can().
 */
export function membershipRolePhrase(role: MembershipRole | null | undefined): string {
  return (role && ROLE_PHRASES[role]) || 'a member';
}

function sameAgency(actor: Actor, resource: Resource): boolean {
  return Boolean(actor.agencyId && resource.agencyId && actor.agencyId === resource.agencyId);
}

function isAgencyAdmin(actor: Actor): boolean {
  return Boolean(actor.membershipRole && ADMIN_ROLES.includes(actor.membershipRole));
}

function isListingAgent(actor: Actor, listingId?: string): boolean {
  if (!listingId || !actor.listingAgentOf) return false;
  return actor.listingAgentOf.includes(listingId);
}

export function can(actor: Actor, action: Action, resource: Resource): boolean {
  switch (action) {
    case 'listing:read':
      if (resource.type === 'listing') {
        return sameAgency(actor, resource) || Boolean(actor.membershipRole);
      }
      return sameAgency(actor, resource);

    case 'listing:create':
      // Any active member of the agency may draft a listing; publishing it is
      // a separate decision, and every new listing starts as a draft.
      return sameAgency(actor, resource) && Boolean(actor.membershipRole);

    case 'listing:edit':
    case 'listing:publish':
      if (!sameAgency(actor, resource)) return false;
      if (isAgencyAdmin(actor)) return true;
      return isListingAgent(actor, resource.id);

    case 'listing:delete':
      // Deliberately narrower than edit. A deleted listing takes its enquiries,
      // inspections and media with it, and an agent who has left the campaign
      // should not be able to erase the agency's record of it. Being named on
      // the listing is enough to change it; it is not enough to remove it.
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'team:manage':
    case 'agency:billing':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'console:agency':
      // Surface gate: actor's own agency membership must be owner|admin
      return Boolean(actor.agencyId) && isAgencyAdmin(actor);

    case 'console:agent':
      return Boolean(actor.agencyId && actor.membershipRole);

    case 'schedule:create':
      // Ownership, not membership. An agency owner gets this because they are
      // a signed-in person, not because of their role — to this action a
      // consumer account and an agent's account are the same kind of thing.
      return Boolean(actor.userId);

    case 'chat:read':
    case 'chat:write':
    case 'schedule:read':
    case 'schedule:manage':
      // Deliberately NOT `|| isAgencyAdmin(actor)`. An agency admin has no
      // claim on a buyer's saved search or their conversation with the guide:
      // between them those record where somebody wants to live, what they can
      // spend and what they asked in their own words. Being the largest
      // account on the platform is not a reason to read any of it. This is the
      // one place in this file where admin power stops at the tenancy line
      // rather than crossing it.
      return Boolean(actor.userId) && actor.userId === resource.ownerId;

    default: {
      /**
       * Exhaustiveness, the same forcing function `getModel` has.
       *
       * This used to be `return false`, which meant a new Action compiled
       * cleanly and silently denied everything — the failure would have shown
       * up as a button that does nothing, with the permission test as the only
       * thing standing between that and production. Adding an action is now a
       * compile error until it has a rule.
       */
      const never: never = action;
      throw new Error(`No rule for action: ${String(never)}`);
    }
  }
}
